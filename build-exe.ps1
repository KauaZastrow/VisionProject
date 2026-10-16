$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$buildPython = Join-Path $PSScriptRoot ".venv-build\Scripts\python.exe"
if (-not (Test-Path $buildPython)) {
    python -m venv .venv-build
    if ($LASTEXITCODE -ne 0) { throw "Falha ao criar o ambiente de build." }
}

& $buildPython -m pip install --upgrade pyinstaller
if ($LASTEXITCODE -ne 0) { throw "Falha ao instalar o PyInstaller." }

& $buildPython -m PyInstaller `
    --noconfirm `
    --clean `
    --onefile `
    --windowed `
    --name Y-Vision `
    --distpath dist `
    --workpath build\pyinstaller `
    --specpath build `
    --add-data "$PSScriptRoot\index.html;." `
    --add-data "$PSScriptRoot\styles.css;." `
    --add-data "$PSScriptRoot\app.js;." `
    launcher.py

if ($LASTEXITCODE -ne 0) { throw "Falha ao gerar o executável." }
Write-Output "Executável criado em: $PSScriptRoot\dist\Y-Vision.exe"