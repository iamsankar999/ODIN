@echo off
setlocal enabledelayedexpansion
title ODIN — Push Release

:: ─────────────────────────────────────────────────────────────────────────────
::  push_release.bat
::  Automates versioning, committing, tagging, and pushing a new ODIN release
::  to GitHub.
::
::  Usage:
::      push_release.bat <version> "<release notes>"
::
::  Example:
::      push_release.bat 2.5.0 "Fixed zone assignment bugs, improved map UX"
::
::  What it does:
::      1. Updates version.json with the new version and today's date
::      2. Commits all changes
::      3. Creates a git tag  v<version>
::      4. Pushes commit + tag to GitHub
::      5. Creates a GitHub Release (if gh CLI is installed)
:: ─────────────────────────────────────────────────────────────────────────────

set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"
set "VERSION_FILE=%ROOT%\version.json"

:: ── Validate arguments ───────────────────────────────────────────────────────
if "%~1"=="" (
    echo.
    echo  ERROR: Version number required.
    echo.
    echo  Usage:   push_release.bat ^<version^> "^<release notes^>"
    echo  Example: push_release.bat 2.5.0 "Bug fixes and performance improvements"
    echo.
    pause & exit /b 1
)

set "NEW_VER=%~1"
set "NOTES=%~2"
if "%NOTES%"=="" set "NOTES=Release v%NEW_VER%"

:: ── Check git is available ───────────────────────────────────────────────────
where git >nul 2>&1
if errorlevel 1 (
    echo.
    echo  ERROR: git is not installed or not in PATH.
    echo         Install Git for Windows: https://git-scm.com/download/win
    echo.
    pause & exit /b 1
)

:: ── Banner ───────────────────────────────────────────────────────────────────
echo.
echo  +======================================================+
echo  ^|   ODIN  ^|  Push Release v%NEW_VER%
echo  +======================================================+
echo.
echo    Notes: %NOTES%
echo.

:: ── Step 1: Update version.json ──────────────────────────────────────────────
echo  [1/5] Updating version.json to v%NEW_VER%...

:: Get today's date in YYYY-MM-DD format
for /f "tokens=2 delims==" %%a in ('wmic os get localdatetime /value') do set "DT=%%a"
set "TODAY=%DT:~0,4%-%DT:~4,2%-%DT:~6,2%"

(
    echo {
    echo   "version": "%NEW_VER%",
    echo   "release_date": "%TODAY%"
    echo }
) > "%VERSION_FILE%"

echo        version.json updated.

:: ── Step 2: Stage all changes ────────────────────────────────────────────────
echo  [2/5] Staging changes...
cd /d "%ROOT%"
git add -A

:: ── Step 3: Commit ───────────────────────────────────────────────────────────
echo  [3/5] Committing...
git commit -m "release: v%NEW_VER% — %NOTES%"
if errorlevel 1 (
    echo.
    echo  WARNING: Nothing to commit, or commit failed.
    echo           Continuing with tag and push...
    echo.
)

:: ── Step 4: Tag ──────────────────────────────────────────────────────────────
echo  [4/5] Creating tag v%NEW_VER%...
git tag -a "v%NEW_VER%" -m "%NOTES%"
if errorlevel 1 (
    echo.
    echo  WARNING: Tag v%NEW_VER% may already exist.
    echo           Delete it first with: git tag -d v%NEW_VER%
    echo.
)

:: ── Step 5: Push ─────────────────────────────────────────────────────────────
echo  [5/5] Pushing to GitHub...
git push origin main --tags
if errorlevel 1 (
    echo.
    echo  ERROR: Push failed. Check your remote and authentication.
    echo         Remote: git remote -v
    echo.
    pause & exit /b 1
)

echo.
echo  +======================================================+
echo  ^|   SUCCESS: v%NEW_VER% pushed to GitHub                 ^|
echo  +======================================================+
echo.

:: ── Bonus: Create GitHub Release if gh CLI available ─────────────────────────
where gh >nul 2>&1
if not errorlevel 1 (
    echo  Creating GitHub Release via gh CLI...
    gh release create "v%NEW_VER%" --title "ODIN v%NEW_VER%" --notes "%NOTES%"
    if not errorlevel 1 (
        echo  GitHub Release created successfully!
    ) else (
        echo  WARNING: gh release create failed. Create it manually on GitHub.
    )
) else (
    echo  TIP: Install GitHub CLI (gh) to auto-create releases:
    echo       https://cli.github.com/
    echo.
    echo  Manual steps to create the release:
    echo    1. Go to: https://github.com/iamsankar999/ODIN/releases/new
    echo    2. Choose tag: v%NEW_VER%
    echo    3. Title: ODIN v%NEW_VER%
    echo    4. Description: %NOTES%
    echo    5. Click "Publish release"
)

echo.
pause
