@echo off
rem Runs the AutoBalloon API for PPAP on http://127.0.0.1:9686.
rem First time: py -3.11 -m venv .venv  then  .venv\Scripts\python -m pip install -r requirements.txt
rem and copy .env.example to .env (set SUPERADMIN_PASSWORD = AUTOBALLOON_PASSWORD in the PPAP .env).
title AutoBalloon API for PPAP (port 9686)
cd /d "%~dp0"
".venv\Scripts\python.exe" -m uvicorn app.main:app --port 9686 --host 127.0.0.1
