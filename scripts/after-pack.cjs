const path = require("node:path");
const { rcedit } = require("rcedit");

module.exports = async (context) => {
  if (context.electronPlatformName !== "win32") return;

  await rcedit(path.join(context.appOutDir, "TelaJunta.exe"), {
    icon: path.join(__dirname, "..", "assets", "icon.ico"),
  });
};
