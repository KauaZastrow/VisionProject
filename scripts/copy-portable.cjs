const fs = require("node:fs");
const path = require("node:path");

const project = require("../package.json");
const releaseDirectory = path.join(__dirname, "..", "release");
const source = path.join(
  releaseDirectory,
  `TelaJunta ${project.version}.exe`,
);
const destination = path.join(releaseDirectory, "TelaJunta.exe");

if (!fs.existsSync(source)) {
  throw new Error(`O executavel portatil esperado nao foi criado: ${source}`);
}

function createPortableExecutable() {
  fs.copyFileSync(source, destination);
  console.log(`Executavel portatil criado: ${destination}`);
}

createPortableExecutable();
