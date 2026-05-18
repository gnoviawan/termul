use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::ServerConfig;
use std::sync::Arc;

pub(crate) async fn is_port_in_use(port: u16) -> bool {
    tokio::net::TcpStream::connect(format!("127.0.0.1:{}", port))
        .await
        .is_ok()
}

pub(crate) fn get_local_ip() -> Option<String> {
    use std::net::UdpSocket;
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    socket.local_addr().ok().map(|addr| addr.ip().to_string())
}

pub(crate) fn generate_self_signed_cert(port: u16) -> Result<(Vec<CertificateDer<'static>>, PrivateKeyDer<'static>), String> {
    let key_pair = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256)
        .map_err(|e| format!("Failed to generate key pair: {}", e))?;

    let mut params = rcgen::CertificateParams::new(vec![
        "localhost".to_string(),
    ]).map_err(|e| format!("Failed to create certificate params: {}", e))?;

    params.distinguished_name = rcgen::DistinguishedName::new();
    params.distinguished_name.push(rcgen::DnType::CommonName, "Termul Web");
    params.distinguished_name.push(rcgen::DnType::OrganizationName, "Termul");
    params.not_before = time::OffsetDateTime::now_utc();
    params.not_after = time::OffsetDateTime::now_utc()
        .checked_add(time::Duration::days(365))
        .unwrap();

    let cert = params.self_signed(&key_pair)
        .map_err(|e| format!("Failed to self-sign certificate: {}", e))?;

    let cert_der = CertificateDer::from(cert.der().to_vec());
    let key_der = PrivateKeyDer::try_from(key_pair.serialize_der())
        .map_err(|e| format!("Failed to convert private key: {}", e))?;

    log::info!("[WsServer] Generated self-signed ECDSA P-256 certificate for localhost:{}", port);
    Ok((vec![cert_der], key_der))
}

#[allow(dead_code)]
pub(crate) fn build_tls_config(certs: Vec<CertificateDer<'static>>, key: PrivateKeyDer<'static>) -> Result<Arc<ServerConfig>, String> {
    let config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|e| format!("Failed to build TLS config: {}", e))?;

    Ok(Arc::new(config))
}
