import { describe, it, expect } from "vitest";
import {
  isPrivateHost,
  extractText,
  readBodyCapped,
  FETCH_BODY_MAX_BYTES,
} from "@/lib/search/fetch-utils";
import { splitParagraphs } from "@/lib/retrieval/doc-segments";

describe("isPrivateHost", () => {
  it("rejects localhost aliases", () => {
    expect(isPrivateHost("localhost")).toBe(true);
    expect(isPrivateHost("LOCALHOST")).toBe(true);
    expect(isPrivateHost("0.0.0.0")).toBe(true);
    expect(isPrivateHost("::1")).toBe(true);
    expect(isPrivateHost("foo.localhost")).toBe(true);
  });

  it("rejects private IPv4 ranges", () => {
    expect(isPrivateHost("10.0.0.1")).toBe(true);
    expect(isPrivateHost("172.16.0.1")).toBe(true);
    expect(isPrivateHost("172.31.255.255")).toBe(true);
    expect(isPrivateHost("192.168.1.1")).toBe(true);
    expect(isPrivateHost("127.0.0.1")).toBe(true);
    expect(isPrivateHost("169.254.169.254")).toBe(true); // metadata endpoint
  });

  it("accepts public IPv4 addresses", () => {
    expect(isPrivateHost("172.15.0.1")).toBe(false); // just below 172.16
    expect(isPrivateHost("172.32.0.1")).toBe(false); // just above 172.31
    expect(isPrivateHost("192.169.0.1")).toBe(false); // not 192.168
    expect(isPrivateHost("8.8.8.8")).toBe(false);
    expect(isPrivateHost("1.1.1.1")).toBe(false);
  });

  it("accepts public hostnames", () => {
    expect(isPrivateHost("example.com")).toBe(false);
    expect(isPrivateHost("sub.example.com")).toBe(false);
    expect(isPrivateHost("en.wikipedia.org")).toBe(false);
  });
});

describe("readBodyCapped", () => {
  it("reads a small body in full, not truncated", async () => {
    const res = new Response("hello world");
    const out = await readBodyCapped(res, 100);
    expect(out.text).toBe("hello world");
    expect(out.truncated).toBe(false);
  });

  it("cuts the stream at the byte cap even without a content-length", async () => {
    const res = new Response("abcdefghij"); // 10 bytes, no declared length
    const out = await readBodyCapped(res, 4);
    expect(out.text).toBe("abcd");
    expect(out.truncated).toBe(true);
  });

  it("marks truncation up front when content-length exceeds the cap", async () => {
    // A truthful content-length over the cap flags the cut even if the body
    // itself turns out short — conservative beats silent.
    const res = new Response("abc", {
      headers: { "content-length": "999999" },
    });
    const out = await readBodyCapped(res, 100);
    expect(out.text).toBe("abc");
    expect(out.truncated).toBe(true);
  });

  it("decodes a mid-character cut safely (replacement char, no throw)", async () => {
    const res = new Response("ééé"); // 2 bytes each in UTF-8
    const out = await readBodyCapped(res, 3); // cuts inside the second char
    expect(out.truncated).toBe(true);
    expect(out.text.startsWith("é")).toBe(true);
  });

  it("caps by BYTES, not characters", async () => {
    const res = new Response("é".repeat(10)); // 20 bytes
    const out = await readBodyCapped(res, 6);
    expect(new TextEncoder().encode(out.text).byteLength).toBeLessThanOrEqual(6);
  });

  it("exports a 2 MB default cap", () => {
    expect(FETCH_BODY_MAX_BYTES).toBe(2 * 1024 * 1024);
  });
});

describe("extractText", () => {
  it("strips script and style contents", () => {
    const html = `<html><head><style>.x{color:red}</style><script>alert(1)</script></head><body><p>Hello</p></body></html>`;
    const text = extractText(html);
    expect(text).toContain("Hello");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("alert");
  });

  it("converts block breaks to newlines", () => {
    const text = extractText("<p>One</p><p>Two</p><div>Three</div><br>Four");
    expect(text).toContain("One");
    expect(text).toContain("Two");
    expect(text).toContain("Three");
    expect(text).toContain("Four");
  });

  it("decodes common HTML entities", () => {
    const text = extractText("a &amp; b &lt; c &gt; d &quot;q&quot; &#39;x&#39;&nbsp;y");
    expect(text).toContain("a & b < c > d \"q\" 'x' y");
  });

  it("collapses runs of whitespace and blank lines", () => {
    const text = extractText("<p>A   B</p>\n\n\n\n<p>C</p>");
    expect(text).toContain("A B");
    expect(text).not.toContain("A   B");
    expect(text).not.toMatch(/\n{3,}/);
  });

  it("strips noscript contents", () => {
    const text = extractText("<noscript>enable JS</noscript><p>Real</p>");
    expect(text).toContain("Real");
    expect(text).not.toContain("enable JS");
  });

  it("preserves structure as markdown (heading/list/link/table)", () => {
    const html = [
      "<h1>Title</h1>",
      `<p>Para with <a href="https://example.com/p">a link</a>.</p>`,
      "<ul><li>one</li><li>two</li></ul>",
      "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>",
    ].join("");
    const text = extractText(html);
    expect(text).toContain("# Title");
    expect(text).toContain("[a link](https://example.com/p)");
    expect(text).toMatch(/\*\s+one/);
    expect(text).toMatch(/\*\s+two/);
    expect(text).toContain("| A | B |");
    expect(text).toContain("| 1 | 2 |");
  });

  it("strips boilerplate containers (nav/header/footer/aside)", () => {
    const html = [
      "<body>",
      `<nav><a href="/a">NavLink</a></nav>`,
      "<header><p>BannerText</p></header>",
      "<h1>Title</h1><p>Real content</p>",
      "<aside>SideBarJunk</aside>",
      `<footer>FooterStuff <a href="/privacy">Privacy</a></footer>`,
      "</body>",
    ].join("");
    const text = extractText(html);
    expect(text).toContain("Real content");
    expect(text).not.toContain("NavLink");
    expect(text).not.toContain("BannerText");
    expect(text).not.toContain("SideBarJunk");
    expect(text).not.toContain("FooterStuff");
  });

  it("returns empty output for whitespace-only input", () => {
    expect(extractText("   ")).toBe("");
  });

  it("yields blank-line separated blocks for the Document Segment Read protocol", () => {
    // splitParagraphs (doc-segments) segments the extracted text on blank
    // lines — markdown output must keep block boundaries as blank lines.
    const html = "<h1>Title</h1><p>First paragraph.</p><p>Second paragraph.</p>";
    const segments = splitParagraphs(extractText(html));
    expect(segments).toHaveLength(3);
    expect(segments[0]).toBe("# Title");
    expect(segments[1]).toBe("First paragraph.");
    expect(segments[2]).toBe("Second paragraph.");
  });
});
