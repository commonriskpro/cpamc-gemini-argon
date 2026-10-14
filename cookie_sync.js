const fs = require("fs");
const path = require("path");

function readNullTerminatedString(buf, offset) {
  let end = offset;
  while (end < buf.length && buf[end] !== 0) end++;
  return buf.toString("utf8", offset, end);
}

function getSafariGoogleCookies() {
  if (process.platform !== "darwin") return [];
  const p = path.join(process.env.HOME || "", "Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies");
  if (!fs.existsSync(p)) return [];

  try {
    const buf = fs.readFileSync(p);
    if (buf.length < 8 || buf.toString("ascii", 0, 4) !== "cook") return [];

    const numPages = buf.readUInt32BE(4);
    const pageSizes = [];
    for (let i = 0; i < numPages; i++) {
      pageSizes.push(buf.readUInt32BE(8 + i * 4));
    }

    let offset = 8 + numPages * 4;
    const cookies = [];

    for (const size of pageSizes) {
      if (offset + size > buf.length) break;
      const page = buf.subarray(offset, offset + size);
      offset += size;

      if (page.length < 8 || page.readUInt32BE(0) !== 0x00000100) continue;
      const numCookies = page.readUInt32LE(4);
      const cookieOffsets = [];
      for (let i = 0; i < numCookies; i++) {
        cookieOffsets.push(page.readUInt32LE(8 + i * 4));
      }

      for (const cOffset of cookieOffsets) {
        if (cOffset >= page.length) continue;
        const cData = page.subarray(cOffset);
        if (cData.length < 32) continue;

        const flags = cData.readUInt32LE(4);
        const urlOffset = cData.readUInt32LE(16);
        const nameOffset = cData.readUInt32LE(20);
        const pathOffset = cData.readUInt32LE(24);
        const valueOffset = cData.readUInt32LE(28);

        const domain = readNullTerminatedString(cData, urlOffset);
        const name = readNullTerminatedString(cData, nameOffset);
        const cookiePath = readNullTerminatedString(cData, pathOffset);
        const value = readNullTerminatedString(cData, valueOffset);

        if (!domain.includes("google.com") || name === "AEC" || name === "NID") continue;

        cookies.push({
          name,
          value,
          domain,
          path: cookiePath,
          secure: Boolean(flags & 1),
          httpOnly: Boolean(flags & 4)
        });
      }
    }
    return cookies;
  } catch (e) {
    return [];
  }
}

function syncAuthFiles(freshCookies, targetEmail) {
  if (!freshCookies || freshCookies.length === 0) return 0;
  const authDir = path.join(process.env.HOME || "", ".cli-proxy-api", "auths");
  if (!fs.existsSync(authDir)) return 0;

  const cookieStr = JSON.stringify(freshCookies);
  let updatedCount = 0;
  try {
    const files = fs.readdirSync(authDir).filter(f => f.startsWith("gemini-argon-") && f.endsWith(".json"));

    for (const f of files) {
      if (targetEmail && !f.includes(targetEmail)) continue;
      const fullPath = path.join(authDir, f);
      try {
        const data = JSON.parse(fs.readFileSync(fullPath, "utf8"));
        data.cookie = cookieStr;
        fs.writeFileSync(fullPath, JSON.stringify(data, null, 2), "utf8");
        updatedCount++;
      } catch (e) {}
    }
  } catch (e) {}
  return updatedCount;
}

async function injectCookies(context, cookies) {
  for (const c of cookies) {
    if (!c.name || typeof c.value !== "string" || c.name.startsWith("__Host-") || c.name === "AEC" || c.name === "NID") continue;
    let domain = c.domain || ".google.com";
    if (!domain.startsWith(".")) domain = "." + domain;
    let secure = Boolean(c.secure);
    if (c.name.startsWith("__Secure-")) secure = true;

    try {
      await context.addCookies([{
        name: c.name,
        value: c.value,
        domain,
        path: c.path || "/",
        secure,
        httpOnly: Boolean(c.httpOnly)
      }]);
    } catch (e) {}
  }
}

function getBestCookies(initialCookies) {
  const safariCookies = getSafariGoogleCookies();
  if (safariCookies && safariCookies.length > 0) {
    const hasPsidts = safariCookies.some(c => c.name === "__Secure-1PSIDTS");
    if (hasPsidts) {
      syncAuthFiles(safariCookies);
      return safariCookies;
    }
  }
  return initialCookies;
}

module.exports = {
  getSafariGoogleCookies,
  syncAuthFiles,
  injectCookies,
  getBestCookies
};
