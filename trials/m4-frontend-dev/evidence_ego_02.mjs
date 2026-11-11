// M4 前端取证 round-02（修身份默认后）：验渲染/display_text 剥头/切房/检索＋截图
const task = await taskSpace("m4-frontend-evidence-20261109");
const page = task.page("p1");
await page.goto("http://127.0.0.1:8790/");
await page.waitForTimeout(1600);

const audit1 = await page.evaluate(() => {
  const msgs = [...document.querySelectorAll(".msg")];
  const rooms = [...document.querySelectorAll(".room")].map((r) => r.querySelector(".name").textContent);
  return {
    msgCount: msgs.length,
    rooms,
    leakHeader: msgs.some((m) => m.querySelector(".body").textContent.startsWith("[huddo:")),
    extShown: msgs.filter((m) => m.querySelector(".ext")).length,
    sample: msgs[0] ? msgs[0].querySelector(".body").textContent.slice(0, 44) : null,
  };
});
console.log("首页: " + JSON.stringify(audit1));

const sw = await page.evaluate(() => {
  const rooms = [...document.querySelectorAll(".room")];
  if (rooms.length < 2) return { err: "不足两房" };
  rooms[1].click();
  return { clicked: rooms[1].querySelector(".name").textContent };
});
await page.waitForTimeout(1400);
const audit2 = await page.evaluate(() => ({
  selected: document.querySelector(".room.sel .name") && document.querySelector(".room.sel .name").textContent,
  msgCount: document.querySelectorAll(".msg").length,
  leakHeader: [...document.querySelectorAll(".msg")].some((m) => m.querySelector(".body").textContent.startsWith("[huddo:")),
}));
console.log("切房: " + JSON.stringify(sw) + " -> " + JSON.stringify(audit2));

await page.evaluate(() => document.querySelector('button[data-view="search"]').click());
await page.evaluate(() => { const q = document.getElementById("q"); q.value = "哈希链"; q.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })); });
await page.waitForTimeout(1300);
const sa = await page.evaluate(() => ({ hits: document.querySelectorAll("#p-search .card").length, first: document.querySelector("#p-search .card") ? document.querySelector("#p-search .card").textContent.slice(0, 70) : null }));
console.log("检索: " + JSON.stringify(sa));

await page.evaluate(() => document.querySelector('button[data-view="duty"]').click());
await page.waitForTimeout(900);
const da = await page.evaluate(() => ({ rows: document.querySelectorAll("#p-duty table tr").length, bad: document.querySelectorAll("#p-duty .tag-bad").length }));
console.log("值班板: " + JSON.stringify(da));

const shot = await page.screenshot();
const fs = await import("node:fs/promises");
if (shot && shot.path) {
  await fs.copyFile(shot.path, "C:/Users/Administrator/AppData/Local/Temp/opencode/m4_duty.png");
} else {
  const data = typeof shot === "string" ? shot : (shot.data || Buffer.from(shot).toString("base64"));
  await fs.writeFile("C:/Users/Administrator/AppData/Local/Temp/opencode/m4_duty.png", Buffer.from(data, "base64"));
}
console.log("截图存 m4_duty.png；spaceId=" + task.spaceId);
