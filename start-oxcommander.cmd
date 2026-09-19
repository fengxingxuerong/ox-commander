@echo off
chcp 65001 >nul
title OxCommander 总指挥智能体
cd /d D:\ox\ox-commander

if not exist node_modules (
  echo [提示] 尚未安装依赖，先执行 npm install...
  call npm install
)

if not exist dist-electron\electron\main.js (
  echo [提示] 尚未构建，先执行 npm run build...
  call npm run build
)

npm start
