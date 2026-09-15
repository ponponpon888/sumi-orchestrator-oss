$ErrorActionPreference = 'Stop'
Write-Host 'Installing SUMI Orchestrator CLI...'
npm link
Write-Host ''
Write-Host 'Installed. Try:'
Write-Host '  sumi init'
Write-Host '  sumi dashboard'
