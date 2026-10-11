param([string]$PsxcoreRoot = 'C:\Users\ddx\Desktop\luna pop\PSXCore')
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$sourceRoot = (Resolve-Path -LiteralPath $PsxcoreRoot).Path
$validator = Join-Path $projectRoot "tests\.psxcore-vcd-native-$PID"
function ConvertTo-WslPath([string]$value) {
    if ($value -notmatch '^[A-Za-z]:\\') { throw 'Native verification requires a local Windows drive path.' }
    return '/mnt/' + $value.Substring(0,1).ToLowerInvariant() + $value.Substring(2).Replace('\','/')
}
$previousValidator = $env:PSXCORE_NATIVE_VALIDATOR
Push-Location -LiteralPath $projectRoot
try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Desktop backend build failed.' }
    $arguments = @('-d', 'Ubuntu-24.04', '--', 'gcc', '-std=c11', '-Wall', '-Wextra', '-Werror',
        '-I', (ConvertTo-WslPath (Join-Path $sourceRoot 'include')),
        (ConvertTo-WslPath (Join-Path $projectRoot 'tests\psxcore-vcd-native.c')),
        (ConvertTo-WslPath (Join-Path $sourceRoot 'src\vcd.c')),
        '-o', (ConvertTo-WslPath $validator))
    & wsl @arguments
    if ($LASTEXITCODE -ne 0) { throw 'Compiling the authoritative PSXCore validator failed.' }
    $env:PSXCORE_NATIVE_VALIDATOR = ConvertTo-WslPath $validator
    node tests/ps1-preparation.test.cjs
    if ($LASTEXITCODE -ne 0) { throw 'PS1 preparation verification failed.' }
    node tests/ps1-renderer.test.cjs
    if ($LASTEXITCODE -ne 0) { throw 'PS1 renderer verification failed.' }
} finally {
    $env:PSXCORE_NATIVE_VALIDATOR = $previousValidator
    if (Test-Path -LiteralPath $validator) { Remove-Item -LiteralPath $validator -Force }
    Pop-Location
}
