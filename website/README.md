# CM FrameKit 官网 / 发布服务器

https://fk.complexmission.com 的 Go 后端：官网、更新日志、软件内版本检测接口、安装包下载（阿里云验证码 + OSS 临时签名链接），以及短信验证码登录的发布后台。

## 运行

```bash
cp .env.example .env     # 填写手机号、短信、验证码、OSS，可选 Redis
go run .                 # 或 go run . -env /path/to/.env
```

本地调试不想接阿里云：`.env` 里设 `SMS_DEV=true`（验证码打印到日志）、`CAPTCHA_DISABLED=true`、`SECURE_COOKIES=false`，不填 OSS（安装包落在 `data/files/`）。

## 部署

```bash
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o fk-site-linux-amd64 .
```

模板和静态文件都编进二进制里，服务器上只需要二进制和 `.env`。`deploy/` 下有 systemd、nginx 样例，宝塔面板见 [deploy/baota.md](deploy/baota.md)。数据都在 `DATA_DIR`：

- `releases.json`：版本记录（版本号、平台、更新说明、OSS key、SHA-256、发布状态、下载次数）
- `logs/audit-YYYY-MM.log`：操作日志（JSON 行）：登录、发验证码、上传、发布/下线、改说明、删除、下载

## 发布流程

1. 打开 `{BASE_URL}{ADMIN_PATH}`，输入 `ADMIN_PHONE`，收短信验证码登录。只有这一个号码能登录，其它号码不会收到短信，界面提示也一样。
2. 填写版本号（`x.y.z` 或 `x.y.z-beta.1`）、平台和更新说明，选择安装包，上传。文件先到服务器，再传进 OSS。
3. 勾选「立即发布」就直接对外可见；不勾就是草稿，之后在列表里点「发布」。
4. 「设为强制」后，旧版本软件启动时会直接弹出更新提示，而且关不掉。
5. 回滚：把最新版「下线」，官网和软件检测会自动回到上一个已发布版本。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/update?version=2.0.0&platform=windows-x64` | 软件检测更新，返回 `update`、`mandatory`、`latest`、`download_page` |
| GET | `/api/latest?platform=windows-x64` | 最新已发布版本 |
| GET | `/api/releases` | 全部已发布版本 |
| POST | `/api/download` | `{platform, version?, captcha}`，验证码通过后返回临时下载链接 |

平台：`windows-x64`、`windows-arm64`、`macos-arm64`、`macos-x64`、`linux-x64`。

下载链接只在通过人机验证后发放，所以软件里的更新提示只打开官网下载页，不直接下文件。

## 验证码加密模式

`CAPTCHA_ENCRYPT=true` 时，页面先请求 `GET /api/captcha-scene` 拿到服务端用 ekey 签出的 `EncryptedSceneId`（AES-256-CBC，随机 IV，`sceneId&timestamp&expireTime`），再用它初始化验证码；快过期时点击下载会自动重新获取。本地保持 `false`。

上线时先改 `.env` 并重启服务，确认能正常下载后，再去控制台打开场景的加密模式开关。顺序反了，所有下载都会验证失败。
