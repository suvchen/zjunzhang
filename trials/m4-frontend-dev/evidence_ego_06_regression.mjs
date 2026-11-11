// M4 取证 round-06（收口回归）：修身份默认＋自动选房后的全链路复核＋窗口数断言
const task = await taskSpace("m4-frontend-evidence-20261109");
const page = task.page("p1");
await page.goto("http://127.0.0.1:8790/");
await page.waitForTimeout(1700);

const a1 = await page.evaluate(() => ({
  msgCount: document.querySelectorAll(".msg").length,
  selected: document.querySelector(".room.sel .name") && document.querySelector(".room.sel .name").textContent,
  leakHeader: [...document.querySelectorAll(".msg")].some((m) => m.querySelector(".body").textContent.startsWith("[huddo:")),
  extShown: document.querySelectorAll(".msg .ext").length,
}));
console.log("首屏: " + JSON.stringify(a1));

const pages = await task.pages();
console.log("窗口/页数=" + pages.length + "（切房前后都应只有 1）");

await page.evaluate(() => { const r = [...document.querySelectorAll(".room")]; if (r.length > 1) r[1].click(); });
await page.waitForTimeout(1200);
const a2 = await page.evaluate(() => document.querySelectorAll(".msg").length);
const pages2 = await task.pages();
console.log("切房后 msg=" + a2 + " 页数=" + pages2.length);

await page.evaluate(() => document.querySelector('button[data-view="search"]').click());
await page.evaluate(() => { const q = document.getElementById("q"); q.value = "工单"; q.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })); });
await page.waitForTimeout(1200);
const sa = await page.evaluate(() => document.querySelectorAll("#p-search .card").length);
console.log("检索(工单)命中=" + sa);

const pass = a1.msgCount === 40 && !a1.leakHeader && a1.extShown > 0 && pages.length === 1 && a2 > 0 && pages2.length === 1 && sa === 19;
console.log("前端判定: " + (pass ? "PASS" : "FAIL"));
