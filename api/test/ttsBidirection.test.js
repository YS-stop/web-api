import test from 'node:test';
import assert from 'node:assert/strict';

import {
    decodeMessage,
    encodeMessage,
    EventType,
    MsgType,
    MsgTypeFlag,
    splitText,
} from '../server/services/ttsBidirection.js';

/** 按官方 protocols.py 的布局手工拼一帧，用来交叉验证解码偏移 */
const frame = ({ type, flag, event, sessionId, connectId, payload = Buffer.alloc(0), withSeq, sequence }) => {
    const head = Buffer.from([0x11, ((type & 0x0f) << 4) | (flag & 0x0f), 0x10, 0x00]);
    const parts = [head];
    if (flag === MsgTypeFlag.WithEvent) {
        const ev = Buffer.alloc(4);
        ev.writeInt32BE(event, 0);
        parts.push(ev);

        const isConn = [1, 2, 50, 51, 52].includes(event);
        if (!isConn) {
            const sid = Buffer.from(sessionId || '', 'utf8');
            const l = Buffer.alloc(4);
            l.writeUInt32BE(sid.length, 0);
            parts.push(l, sid);
        }
        if ([50, 51, 52].includes(event)) {
            const cid = Buffer.from(connectId || '', 'utf8');
            const l = Buffer.alloc(4);
            l.writeUInt32BE(cid.length, 0);
            parts.push(l, cid);
        }
    }
    if (withSeq) {
        const s = Buffer.alloc(4);
        s.writeInt32BE(sequence || 0, 0);
        parts.push(s);
    }
    const pl = Buffer.alloc(4);
    pl.writeUInt32BE(payload.length, 0);
    parts.push(pl, payload);
    return Buffer.concat(parts);
};

test('StartConnection 帧严格等于官方字节序列', () => {
    const buf = encodeMessage({
        type: MsgType.FullClientRequest,
        flag: MsgTypeFlag.WithEvent,
        event: EventType.StartConnection,
        payload: Buffer.from('{}'),
    });

    // 0x11 版本+4字节头 / 0x14 客户端完整请求+WithEvent / 0x10 JSON 不压缩 / 0x00 保留
    assert.deepEqual([...buf.subarray(0, 4)], [0x11, 0x14, 0x10, 0x00]);
    // 连接类事件不带 session id：4 header + 4 event + 4 payloadLen + 2 payload
    assert.equal(buf.length, 14);
    assert.equal(buf.readInt32BE(4), EventType.StartConnection);
    assert.equal(buf.readUInt32BE(8), 2);
    assert.equal(buf.subarray(12).toString('utf8'), '{}');
});

test('StartSession 帧带 session id 段', () => {
    const buf = encodeMessage({
        type: MsgType.FullClientRequest,
        flag: MsgTypeFlag.WithEvent,
        event: EventType.StartSession,
        sessionId: 'sid-1',
        payload: Buffer.from('{"a":1}'),
    });

    assert.equal(buf.readInt32BE(4), EventType.StartSession);
    assert.equal(buf.readUInt32BE(8), 5);
    assert.equal(buf.toString('utf8', 12, 17), 'sid-1');
    assert.equal(buf.readUInt32BE(17), 7);
    assert.equal(buf.subarray(21).toString('utf8'), '{"a":1}');
});

test('编解码往返：会话事件', () => {
    const payload = JSON.stringify({ event: EventType.TaskRequest, req_params: { text: '你好' } });
    const buf = encodeMessage({
        type: MsgType.FullClientRequest,
        flag: MsgTypeFlag.WithEvent,
        event: EventType.TaskRequest,
        sessionId: 'abc',
        payload,
    });

    const msg = decodeMessage(buf);
    assert.equal(msg.type, MsgType.FullClientRequest);
    assert.equal(msg.flag, MsgTypeFlag.WithEvent);
    assert.equal(msg.event, EventType.TaskRequest);
    assert.equal(msg.sessionId, 'abc');
    assert.equal(msg.payload.toString('utf8'), payload);
});

test('解码服务端 ConnectionStarted：先 connect id 再 payload，不读 session id', () => {
    const buf = frame({
        type: MsgType.FullServerResponse,
        flag: MsgTypeFlag.WithEvent,
        event: EventType.ConnectionStarted,
        connectId: 'conn-1',
        payload: Buffer.from('{}'),
    });

    const msg = decodeMessage(buf);
    assert.equal(msg.type, MsgType.FullServerResponse);
    assert.equal(msg.event, EventType.ConnectionStarted);
    assert.equal(msg.sessionId, '');
    assert.equal(msg.connectId, 'conn-1');
    assert.equal(msg.payload.toString('utf8'), '{}');
});

test('解码服务端音频帧（session id + 裸音频字节）', () => {
    const audio = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0x00]);
    const buf = frame({
        type: MsgType.AudioOnlyServer,
        flag: MsgTypeFlag.WithEvent,
        event: EventType.TTSResponse,
        sessionId: 'sid',
        payload: audio,
    });

    const msg = decodeMessage(buf);
    assert.equal(msg.type, MsgType.AudioOnlyServer);
    assert.equal(msg.event, EventType.TTSResponse);
    assert.equal(msg.sessionId, 'sid');
    assert.deepEqual([...msg.payload], [...audio]);
});

test('解码带序号的音频帧', () => {
    const audio = Buffer.from([1, 2, 3]);
    const buf = frame({
        type: MsgType.AudioOnlyServer,
        flag: MsgTypeFlag.PositiveSeq,
        withSeq: true,
        sequence: 7,
        payload: audio,
    });

    const msg = decodeMessage(buf);
    assert.equal(msg.flag, MsgTypeFlag.PositiveSeq);
    assert.equal(msg.sequence, 7);
    assert.deepEqual([...msg.payload], [...audio]);
});

test('解码 Error 帧：error code 在 event 之前', () => {
    const head = Buffer.from([0x11, 0xf4, 0x10, 0x00]);
    const code = Buffer.alloc(4);
    code.writeUInt32BE(45000030, 0);
    const ev = Buffer.alloc(4);
    ev.writeInt32BE(EventType.SessionFailed, 0);
    const sid = Buffer.from('s', 'utf8');
    const sidLen = Buffer.alloc(4);
    sidLen.writeUInt32BE(sid.length, 0);
    const body = Buffer.from('{"error":"resource not granted"}', 'utf8');
    const bodyLen = Buffer.alloc(4);
    bodyLen.writeUInt32BE(body.length, 0);

    const msg = decodeMessage(Buffer.concat([head, code, ev, sidLen, sid, bodyLen, body]));
    assert.equal(msg.type, MsgType.Error);
    assert.equal(msg.errorCode, 45000030);
    assert.equal(msg.event, EventType.SessionFailed);
    assert.match(msg.payload.toString('utf8'), /not granted/);
});

test('splitText 按标点分块且不丢字', () => {
    const text = '第一句话。第二句话！第三句话？' + '很长的一段没有标点的文本'.repeat(6);
    const chunks = splitText(text, { maxChars: 20 });

    assert.ok(chunks.length > 1);
    for (const c of chunks) assert.ok(c.length <= 20);
    assert.equal(chunks.join(''), text);
});

test('splitText 处理空文本', () => {
    assert.deepEqual(splitText(''), []);
    assert.deepEqual(splitText('   '), []);
});
