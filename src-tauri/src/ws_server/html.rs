pub(crate) fn get_index_html() -> String {
    std::fs::read_to_string("../dist-web/web-index.html")
        .or_else(|_| std::fs::read_to_string("dist-web/web-index.html"))
        .unwrap_or_else(|_| include_str!("index.html").to_string())
}

