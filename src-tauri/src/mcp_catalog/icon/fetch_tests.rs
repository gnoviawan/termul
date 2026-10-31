use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::Path;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use url::Url;

use super::fetch::{is_public, sniff, FetchError, IconClient, Lookup, Policy, Refused};
use super::IconType;

const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

fn lookup(answers: &[(&str, &[&str])]) -> Lookup {
    let answers: HashMap<String, Vec<IpAddr>> = answers
        .iter()
        .map(|(host, ips)| {
            (
                host.to_string(),
                ips.iter().map(|ip| ip.parse().unwrap()).collect(),
            )
        })
        .collect();
    let answers = Arc::new(answers);
    Arc::new(move |host| {
        let ips = answers.get(&host).cloned().unwrap_or_default();
        Box::pin(async move { Ok(ips) })
    })
}

const LOCAL_HTTP: Policy = Policy {
    scheme: "http",
    allows: |ip| ip.is_loopback() || is_public(ip),
};

struct Server {
    port: u16,
    hits: Arc<AtomicUsize>,
}

async fn serve() -> Server {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let hits = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&hits);
    let app = axum::Router::new()
        .route(
            "/png-as-text",
            get(|| async { ([(header::CONTENT_TYPE, "text/plain")], PNG) }),
        )
        .route(
            "/html-as-png",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "image/png")],
                    "<!doctype html><html><script>alert(1)</script></html>",
                )
            }),
        )
        .route(
            "/huge",
            get(|| async {
                let mut body = PNG.to_vec();
                body.resize(600 * 1024, 0);
                ([(header::CONTENT_TYPE, "image/png")], body)
            }),
        )
        .route(
            "/huge-stream",
            get(|| async {
                let chunks = (0..10).map(|_| Ok::<_, std::io::Error>(vec![0u8; 64 * 1024]));
                Body::from_stream(futures::stream::iter(chunks))
            }),
        )
        .route("/missing", get(|| async { StatusCode::NOT_FOUND }))
        .route(
            "/hop/{n}",
            get(move |Path(n): Path<u32>| async move {
                let to = if n == 0 {
                    "/png-as-text".to_string()
                } else {
                    format!("/hop/{}", n - 1)
                };
                redirect(&to)
            }),
        )
        .route(
            "/to-private",
            get(
                move || async move { redirect(&format!("http://private.test:{port}/png-as-text")) },
            ),
        )
        .route(
            "/to-private-ip",
            get(|| async { redirect("http://10.0.0.1/png-as-text") }),
        )
        .layer(axum::middleware::from_fn(
            move |request: axum::extract::Request, next: axum::middleware::Next| {
                let counted = Arc::clone(&counted);
                async move {
                    counted.fetch_add(1, Ordering::SeqCst);
                    next.run(request).await
                }
            },
        ));
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Server { port, hits }
}

fn redirect(to: &str) -> Response {
    (StatusCode::FOUND, [(header::LOCATION, to.to_string())]).into_response()
}

fn local_client(port: u16) -> (IconClient, impl Fn(&str) -> Url) {
    let client = IconClient::new(
        LOCAL_HTTP,
        lookup(&[
            ("icons.test", &["127.0.0.1"]),
            ("private.test", &["10.0.0.7"]),
            ("rebind.test", &["192.168.1.20"]),
        ]),
    )
    .unwrap();
    (client, move |path: &str| {
        Url::parse(&format!("http://icons.test:{port}{path}")).unwrap()
    })
}

#[test]
fn only_public_addresses_are_public() {
    for ip in [
        "0.0.0.0",
        "0.1.2.3",
        "127.0.0.1",
        "10.1.2.3",
        "172.16.0.1",
        "192.168.0.1",
        "169.254.169.254",
        "100.64.0.1",
        "100.127.255.255",
        "224.0.0.1",
        "255.255.255.255",
        "240.0.0.1",
        "192.0.0.8",
        "198.18.0.1",
        "192.0.2.1",
        "::",
        "::1",
        "fc00::1",
        "fd12::1",
        "fe80::1",
        "fec0::1",
        "ff02::1",
        "::ffff:127.0.0.1",
        "::ffff:10.0.0.1",
        "::10.0.0.1",
        "64:ff9b::a00:1",
        "2002:a00:1::",
        "2001:db8::1",
        "2001:0:4136:e378::1",
    ] {
        assert!(!is_public(ip.parse().unwrap()), "{ip} is not public");
    }
    for ip in [
        "93.184.216.34",
        "8.8.8.8",
        "100.128.0.1",
        "2606:4700::1111",
        "::ffff:93.184.216.34",
        "64:ff9b::808:808",
    ] {
        assert!(is_public(ip.parse().unwrap()), "{ip} is public");
    }
}

#[test]
fn the_policy_refuses_http_and_non_public_ip_literals() {
    let check = |url: &str| Policy::PUBLIC_HTTPS.check(&Url::parse(url).unwrap());
    assert_eq!(check("http://a.example/icon.png"), Err(Refused::NotHttps));
    assert_eq!(
        check("https://127.0.0.1/icon.png"),
        Err(Refused::NonPublicAddress)
    );
    assert_eq!(
        check("https://[::1]/icon.png"),
        Err(Refused::NonPublicAddress)
    );
    assert_eq!(
        check("https://169.254.169.254/latest"),
        Err(Refused::NonPublicAddress)
    );
    assert_eq!(check("https://93.184.216.34/icon.png"), Ok(()));
    assert_eq!(check("https://a.example/icon.png"), Ok(()));
}

#[test]
fn sniffing_trusts_the_bytes_not_the_label() {
    assert_eq!(sniff(PNG), Some(IconType::Png));
    assert_eq!(sniff(b"\xff\xd8\xff\xe0\0\x10JFIF"), Some(IconType::Jpeg));
    assert_eq!(sniff(b"GIF89a\x01\0"), Some(IconType::Gif));
    assert_eq!(sniff(b"RIFF\x24\0\0\0WEBPVP8 "), Some(IconType::Webp));
    assert_eq!(
        sniff(b"<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"),
        Some(IconType::Svg)
    );
    assert_eq!(
        sniff(
            "\u{feff}<?xml version=\"1.0\"?>\n<!-- logo -->\n<!DOCTYPE svg>\n<svg>\n</svg>"
                .as_bytes()
        ),
        Some(IconType::Svg)
    );
    for not_an_icon in [
        &b"<!doctype html><html></html>"[..],
        b"<html><svg></svg></html>",
        b"<svgx>",
        b"<!-- never closed <svg>",
        b"\x89PNX",
        b"RIFF\0\0\0\0WAVE",
        b"",
        b"\xff\xfe<\0s\0v\0g\0",
    ] {
        assert_eq!(sniff(not_an_icon), None, "{not_an_icon:?}");
    }
}

#[tokio::test]
async fn a_png_labelled_text_is_served_as_png() {
    let server = serve().await;
    let (client, url) = local_client(server.port);
    let icon = client.fetch(&url("/png-as-text")).await.unwrap();
    assert_eq!(icon.content_type, IconType::Png);
    assert_eq!(&*icon.bytes, PNG);
}

#[tokio::test]
async fn an_html_body_labelled_image_png_is_refused() {
    let server = serve().await;
    let (client, url) = local_client(server.port);
    assert_eq!(
        client.fetch(&url("/html-as-png")).await,
        Err(FetchError::NotAnImage)
    );
}

#[tokio::test]
async fn bodies_over_the_cap_are_refused_with_or_without_a_length() {
    let server = serve().await;
    let (client, url) = local_client(server.port);
    assert_eq!(client.fetch(&url("/huge")).await, Err(FetchError::TooLarge));
    assert_eq!(
        client.fetch(&url("/huge-stream")).await,
        Err(FetchError::TooLarge)
    );
}

#[tokio::test]
async fn an_error_status_is_a_failure() {
    let server = serve().await;
    let (client, url) = local_client(server.port);
    assert_eq!(
        client.fetch(&url("/missing")).await,
        Err(FetchError::Status(404))
    );
}

#[tokio::test]
async fn up_to_three_redirects_are_followed_and_a_fourth_is_refused() {
    let server = serve().await;
    let (client, url) = local_client(server.port);
    assert_eq!(
        client
            .fetch(&url("/hop/2"))
            .await
            .map(|icon| icon.content_type),
        Ok(IconType::Png)
    );
    assert_eq!(
        client.fetch(&url("/hop/3")).await,
        Err(FetchError::Refused(Refused::TooManyRedirects))
    );
}

#[tokio::test]
async fn a_redirect_to_a_private_host_or_ip_is_refused() {
    let server = serve().await;
    let (client, url) = local_client(server.port);
    assert_eq!(
        client.fetch(&url("/to-private")).await,
        Err(FetchError::Refused(Refused::NonPublicAddress))
    );
    assert_eq!(
        client.fetch(&url("/to-private-ip")).await,
        Err(FetchError::Refused(Refused::NonPublicAddress))
    );
}

#[tokio::test]
async fn a_name_that_resolves_private_is_refused_before_any_request() {
    let server = serve().await;
    let (client, _) = local_client(server.port);
    let rebound = Url::parse(&format!("http://rebind.test:{}/png-as-text", server.port)).unwrap();
    assert_eq!(
        client.fetch(&rebound).await,
        Err(FetchError::Refused(Refused::NonPublicAddress))
    );
    assert_eq!(server.hits.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn production_rules_refuse_loopback_answers_and_mixed_answers() {
    let client = IconClient::new(
        Policy::PUBLIC_HTTPS,
        lookup(&[
            ("loopback.test", &["127.0.0.1"]),
            ("mixed.test", &["93.184.216.34", "10.0.0.1"]),
            ("metadata.test", &["169.254.169.254"]),
            ("nothing.test", &[]),
        ]),
    )
    .unwrap();
    for (host, refused) in [
        ("loopback.test", Refused::NonPublicAddress),
        ("mixed.test", Refused::NonPublicAddress),
        ("metadata.test", Refused::NonPublicAddress),
        ("nothing.test", Refused::NoAddresses),
    ] {
        let url = Url::parse(&format!("https://{host}/icon.png")).unwrap();
        assert_eq!(
            client.fetch(&url).await,
            Err(FetchError::Refused(refused)),
            "{host}"
        );
    }
}
