import { chromium } from "@playwright/test";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://localhost:3000/zh/timeline", { waitUntil: "networkidle" });
await page.waitForTimeout(6000);
const result = await page.evaluate(() => {
  const all = [...document.querySelectorAll("div, span, p")];
  const findBy = (re) => all.find((el) => el.children.length === 0 && re.test((el.textContent ?? "").trim()));
  const cf = (el) => (el ? getComputedStyle(el).fontFamily : null);
  return {
    fr: cf(findBy(/^FR\.\d{8}$/)),
    no: cf(findBy(/^No\.\d{4}·\d{4}$/)),
    ledgerKey: cf(findBy(/^(未决|线索|基调|决定)$/)),
    time: cf(findBy(/^\d{4}\s*\/\s*\d{1,2}\s*\/\s*\d{1,2}/)),
  };
});
console.log(JSON.stringify(result, null, 2));
await browser.close();
