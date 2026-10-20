/**
 * crypto.randomUUID polyfill
 *
 * crypto.randomUUID 仅在安全上下文（HTTPS / localhost）可用。
 * 通过局域网 IP（http://192.168.x.x）访问时它是 undefined，会导致
 * 添加节点等操作静默失败。这里在非安全上下文下兜底一个 UUID 实现。
 */
if (typeof crypto !== 'undefined' && typeof (crypto as any).randomUUID !== 'function') {
    (crypto as any).randomUUID = function () {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = (Math.random() * 16) | 0;
            const v = c === 'x' ? r : (r & 0x3) | 0x8;
            return v.toString(16);
        });
    };
}

export {};
