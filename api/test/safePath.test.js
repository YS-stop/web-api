/**
 * resolveInside 目录逃逸防护单测
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveInside } from '../server/utils/safePath.js';

const BASE = path.resolve('/data/library/workflows');

test('resolveInside: 正常文件名解析到基准目录内', () => {
    assert.equal(resolveInside(BASE, 'abc.json'), path.join(BASE, 'abc.json'));
    assert.equal(resolveInside(BASE, 'animal Dancing.json'), path.join(BASE, 'animal Dancing.json'));
});

test('resolveInside: ../ 逃逸被拒绝', () => {
    assert.equal(resolveInside(BASE, '../users.json'), null);
    assert.equal(resolveInside(BASE, '../../server/index.js'), null);
    assert.equal(resolveInside(BASE, '..%2Fusers.json'.replace('%2F', '/')), null);
});

test('resolveInside: 绝对路径被拒绝', () => {
    assert.equal(resolveInside(BASE, '/etc/passwd'), null);
    assert.equal(resolveInside(BASE, 'C:\\Windows\\win.ini'), null);
});

test('resolveInside: 指向基准目录自身被拒绝', () => {
    assert.equal(resolveInside(BASE, '.'), null);
    assert.equal(resolveInside(BASE), null);
});

test('resolveInside: 形似前缀的同级目录不算逃逸', () => {
    assert.equal(resolveInside(BASE, '../workflows-evil/x.json'), null);
});
