# -*- mode: python ; coding: utf-8 -*-


a = Analysis(
    ['../launcher.py'],
    pathex=[],
    binaries=[],
    datas=[('C:/Users/kaua_zastrow/Downloads/Y-vision/index.html', '.'), ('C:/Users/kaua_zastrow/Downloads/Y-vision/styles.css', '.'), ('C:/Users/kaua_zastrow/Downloads/Y-vision/app.js', '.')],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='Y-Vision',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
