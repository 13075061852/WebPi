import assert from 'node:assert/strict';
import { restoreWindowState } from '../src/main/window-state.mjs';

const primary = {workArea:{x:0,y:0,width:1920,height:1040}};
const secondary = {workArea:{x:-1600,y:0,width:1600,height:900}};
const saved = {bounds:{x:120,y:80,width:700,height:800},maximized:false};
assert.deepEqual(restoreWindowState(saved,[primary],primary).bounds,saved.bounds);
const left = {bounds:{x:-1500,y:20,width:900,height:850},maximized:true};
assert.deepEqual(restoreWindowState(left,[primary,secondary],primary).bounds,left.bounds);
assert.equal(restoreWindowState(left,[primary,secondary],primary).maximized,true);
const disconnected=restoreWindowState(left,[primary],primary).bounds;
assert.ok(disconnected.x>=0&&disconnected.x+disconnected.width<=1920);
const smaller={workArea:{x:50,y:30,width:1000,height:680}};
const clamped=restoreWindowState({bounds:{x:60,y:40,width:1800,height:1200}},[smaller],smaller);
assert.deepEqual(clamped.bounds,{x:50,y:30,width:1000,height:680});
assert.equal(clamped.minHeight,680);
for (const bad of [null,{bounds:{x:NaN,y:0,width:500,height:700}},{bounds:{x:0,y:0,width:-1,height:700}}]) {
  assert.deepEqual(restoreWindowState(bad,[primary],primary).bounds,{x:240,y:70,width:1440,height:900});
}
assert.deepEqual(restoreWindowState({bounds:{x:10,y:10,width:100,height:100}},[primary],primary).bounds,{x:10,y:10,width:520,height:720});
console.log('PASS saved geometry, maximized state, negative-coordinate display, disconnected monitor, smaller desktop and invalid bounds');
