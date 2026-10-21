# 宝塔面板部署

## 1. 编译（本机）

```bash
cd website
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o fk-site-linux-amd64 .
```

模板、CSS、JS、截图、PhotoSwipe 都编进了二进制，服务器上只要两个文件：`fk-site-linux-amd64` 和 `.env`。

## 2. 上传

宝塔「文件」里新建 `/www/wwwroot/fk-site/`，上传这两个文件，然后在终端执行：

```bash
cd /www/wwwroot/fk-site
chmod +x fk-site-linux-amd64
chmod 600 .env
mkdir -p data
./fk-site-linux-amd64 -env .env -push-test   # 能收到推送就说明 .env 读得到、网络通
```

`.env` 建议这样设置：

```
ADDR=127.0.0.1:22341                 # 只监听本机，外网走 nginx
DATA_DIR=/www/wwwroot/fk-site/data   # 绝对路径，守护进程的工作目录不一定是这里
SECURE_COOKIES=true
TRUST_PROXY=true
SMS_DEV=false
CAPTCHA_DISABLED=false
```

## 3. 守护进程（二选一）

**A. 网站 → Go 项目 → 添加项目**

- 项目执行文件：`/www/wwwroot/fk-site/fk-site-linux-amd64`
- 项目名称：`fk-site`
- 项目端口：`22341`（不要放行防火墙）
- 执行命令：`/www/wwwroot/fk-site/fk-site-linux-amd64 -env /www/wwwroot/fk-site/.env`
- 运行用户：`www`
- 绑定域名：`fk.complexmission.com`，开启「外网映射」，宝塔会自动生成反向代理

**B. 软件商店 → 进程守护管理器（Supervisor）**

- 启动命令同上，运行目录 `/www/wwwroot/fk-site`，运行用户 `www`
- 然后「网站 → 添加站点」建 `fk.complexmission.com`（纯静态即可），在「反向代理」里指向 `http://127.0.0.1:22341`

`data/` 必须对运行用户可写：`chown -R www:www /www/wwwroot/fk-site`。

## 4. SSL 与 nginx 配置

站点设置 → SSL → Let's Encrypt 申请证书，开启「强制 HTTPS」。

然后在站点的「配置文件」（或反向代理的配置文件）里，`location /` 的代理配置中补上：

```nginx
# 后台上传安装包：与 MAX_UPLOAD_MB 一致，不缓冲，超时放长
client_max_body_size 1024m;
proxy_request_buffering off;
proxy_read_timeout 600s;
proxy_send_timeout 600s;

# 真实客户端 IP（限流与日志用）
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header Host $host;
```

### /changelog 被宝塔拦截

宝塔默认有一条禁止访问 CHANGELOG、README 等文件的规则，会把 `/changelog`（更新日志页）直接 404。在站点配置文件里、其它 `location` 之前加一个精确匹配（端口按 `ADDR` 填）：

```nginx
location = /changelog {
    proxy_pass http://127.0.0.1:22341;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

### Content-Security-Policy

其它安全响应头（HSTS、Permissions-Policy、COOP、CORP、X-Frame-Options 等）由程序自己输出。CSP 放在 nginx 里，和上面的代理配置写在同一个 `location /` 块里：

```nginx
add_header Content-Security-Policy "default-src 'self'; script-src 'self' https://o.alicdn.com https://g.alicdn.com; style-src 'self' 'unsafe-inline' https://g.alicdn.com; img-src 'self' data: blob: https://*.alicdn.com https://*.aliyuncs.com; font-src 'self' data: https://g.alicdn.com; connect-src 'self' data: https://*.aliyuncs.com; frame-src https://*.alicdn.com https://*.aliyuncs.com; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests" always;
```

- `alicdn.com` / `aliyuncs.com` 是阿里云验证码的 SDK、样式、设备检测和校验接口；`connect-src` 里的 `data:` 也是验证码 SDK 需要的，去掉会导致验证码失败。
- `style-src 'unsafe-inline'` 同样是验证码 SDK 注入样式所需。
- nginx 的 `add_header` 写在某个 `location` 里时，该 location 不再继承上层的 `add_header`。所以要和其它 `add_header` 放在同一层，并且带上 `always`。
- 如果为 `/changelog` 单独加过 `location = /changelog { … }`（绕开宝塔禁止访问 CHANGELOG 的规则），这一行也要在那个块里再写一次，否则更新日志页没有 CSP。
- 改完执行 `nginx -t` 检查，再重载。

宝塔默认的反向代理会开启缓存，对本站要**关闭**（站点 → 反向代理 → 编辑 → 关闭缓存）。否则下载接口、版本检测和后台页面都可能被缓存。

## 5. 验证

- `https://fk.complexmission.com/healthz` 返回 `ok`
- 首页、更新日志、留言页能打开；下载按钮会弹出阿里云验证码
- `https://fk.complexmission.com` + 你在 `.env` 里设的 `ADMIN_PATH`，用短信登录，上传第一个安装包
- 推送中心收到「官网服务已启动」「后台登录成功」等消息

确认能正常下载后，把 `.env` 里的 `CAPTCHA_ENCRYPT` 改成 `true` 并重启，再去阿里云验证码控制台打开场景的加密模式。

## 更新

本机重新编译后，上传覆盖 `fk-site-linux-amd64`，在 Go 项目 / 进程守护里重启即可。`data/`（版本记录与日志）和 `.env` 不要覆盖。
