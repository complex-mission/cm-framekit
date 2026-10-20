fn main() {
    tauri_build::build();

    // 单元测试可执行文件没有 tauri-build 给主程序嵌的清单，缺 Common-Controls v6 时
    // 启动即 STATUS_ENTRYPOINT_NOT_FOUND（TaskDialogIndirect）。给测试目标也嵌一份。
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg-tests=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'");
    }
}
