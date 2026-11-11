// 事件流并发追加子进程：node event-append-child.mjs <home> <project> <count>
import process from 'node:process';
import { event } from '../../src/events.js';

const [home, project, rawCount] = process.argv.slice(2);
const count = Number(rawCount) || 1;
for (let i = 0; i < count; i += 1) {
  const result = event.append(home, {
    project,
    type: 'probe',
    actor: `child-${process.pid}`,
    subject: project,
    payload: { i },
  });
  if (!result || !result.ok) {
    process.stderr.write(JSON.stringify(result) + '\n');
    process.exit(1);
  }
}
