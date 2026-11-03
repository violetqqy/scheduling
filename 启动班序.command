#!/bin/zsh
cd "${0:A:h}" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "请先安装Node.js 22或更新版本，再重新打开。"
  read -r "reply?按回车退出"
  exit 1
fi
if [ ! -d node_modules ]; then
  npm install || exit 1
fi
echo "班序启动后，请在浏览器打开 http://127.0.0.1:5178/"
echo "账号 admin，密码 Admin@123456。关闭此窗口或按Control+C可停止服务。"
npm run dev
