import { describe, it, expect } from "vitest";
import { isPrivateHost, extractText } from "@/lib/search/fetch-utils";

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
    const text = extractText("a &amp; b &lt; c &gt; d &quot;q&quot; &#39;x&#39; &nbsp;y");
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
});
