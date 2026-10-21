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

站点设置 → SSL：部署证书（Let's Encrypt 或已购证书），开启「强制 HTTPS」。阿里云安全组和宝塔「安全」里都要放行 **80 和 443**，否则 `http://` 访问连不上，也就跳转不到 https。

然后在站点「配置文件」里，把反向代理那一段（`# HTTP反向代理相关配置开始 >>>` 到 `结束 <<<`）换成下面的内容。端口按 `.env` 的 `ADDR` 填。这份配置已在线上验证过。

```nginx
    # HTTP反向代理相关配置开始 >>>
    # 只允许本机清缓存，否则任何人都能清空缓存
    location ~ /purge(/.*) {
        allow 127.0.0.1;
        deny all;
        proxy_cache_purge cache_one $host$request_uri$is_args$args;
    }

    # 宝塔「禁止访问的敏感文件」规则会拦截 CHANGELOG，精确匹配优先于正则，用它放行更新日志页
    location = /changelog {
        proxy_pass http://127.0.0.1:22341;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        add_header Alt-Svc 'h3=":443"; ma=86400';
        add_header Content-Security-Policy "default-src 'self'; script-src 'self' https://o.alicdn.com https://g.alicdn.com; style-src 'self' 'unsafe-inline' https://g.alicdn.com; img-src 'self' data: blob: https://*.alicdn.com https://*.aliyuncs.com; font-src 'self' data: https://g.alicdn.com; connect-src 'self' data: https://*.aliyuncs.com; frame-src https://*.alicdn.com https://*.aliyuncs.com; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests" always;
    }

    location / {
        proxy_pass http://127.0.0.1:22341;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        # 真实客户端 IP（限流与日志用）；不要用 $proxy_add_x_forwarded_for，它会带上客户端伪造的值
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 30s;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
        # 后台上传安装包：与 .env 的 MAX_UPLOAD_MB 一致，不缓冲
        client_max_body_size 1024m;
        proxy_request_buffering off;
        add_header X-Cache $upstream_cache_status;
        add_header Alt-Svc 'h3=":443"; ma=86400';
        add_header Content-Security-Policy "default-src 'self'; script-src 'self' https://o.alicdn.com https://g.alicdn.com; style-src 'self' 'unsafe-inline' https://g.alicdn.com; img-src 'self' data: blob: https://*.alicdn.com https://*.aliyuncs.com; font-src 'self' data: https://g.alicdn.com; connect-src 'self' data: https://*.aliyuncs.com; frame-src https://*.alicdn.com https://*.aliyuncs.com; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests" always;
    }
    # HTTP反向代理相关配置结束 <<<
```

要点：

- **响应头分工**：HSTS、Permissions-Policy、COOP、CORP、X-Frame-Options、X-Content-Type-Options、Referrer-Policy 都由程序输出，nginx 里**不要再加 HSTS**，否则会出现两个。CSP 只放在 nginx。
- **`add_header` 不继承**：一个 `location` 里只要写了任何 `add_header`，就不再继承 `server` 层的 `add_header`。所以 CSP 和 `Alt-Svc` 要在两个 location 里各写一次。server 层宝塔自动加的 HSTS 因此不会生效，可以在 SSL 设置里关掉 HSTS 开关。
- **CSP 里的阿里云域名**：`alicdn.com` / `aliyuncs.com` 是阿里云验证码的 SDK、样式、设备检测和校验接口。`connect-src` 里的 `data:` 和 `style-src` 里的 `'unsafe-inline'` 也是验证码 SDK 需要的，去掉会导致验证码失败。
- **不要在宝塔「反向代理」界面里点保存**：它会按模板重新生成这一段，覆盖上面的改动。以后都直接改配置文件。
- **缓存**：宝塔的代理缓存只会缓存静态文件（`X-Cache: HIT`），动态页面和接口每次都是 `MISS`。静态文件地址带内容哈希（`?v=…`），更新后不用手动清缓存。如果发现页面或 `/api/` 出现 `HIT`，就把缓存关掉。
- 改完执行 `nginx -t` 检查，再重载。

## 5. 验证

- `https://fk.complexmission.com/healthz` 返回 `ok`
- 首页、更新日志、留言页能打开；下载按钮会弹出阿里云验证码
- `https://fk.complexmission.com` + 你在 `.env` 里设的 `ADMIN_PATH`，用短信登录，上传第一个安装包
- 推送中心收到「官网服务已启动」「后台登录成功」等消息

确认能正常下载后，把 `.env` 里的 `CAPTCHA_ENCRYPT` 改成 `true` 并重启，再去阿里云验证码控制台打开场景的加密模式。

## 更新

本机重新编译后，上传覆盖 `fk-site-linux-amd64`，在 Go 项目 / 进程守护里重启即可。`data/`（版本记录与日志）和 `.env` 不要覆盖。
