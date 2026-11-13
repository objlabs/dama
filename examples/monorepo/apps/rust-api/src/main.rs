// Minimal routing smoke test. Use your production framework in real services.
use std::env;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::Duration;

fn main() {
    let port = env::var("PORT").unwrap_or_else(|_| "8080".into());
    let base = env::var("DAMA_BASE_PATH").unwrap_or_default();
    let base = base.trim_end_matches('/');
    let home = format!("{}/", base);
    let health = format!("{}/health", base);
    let listener = TcpListener::bind(format!("0.0.0.0:{}", port)).expect("bind failed");
    for mut stream in listener.incoming().flatten() {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));
        let mut data = [0; 8192];
        let Ok(count) = stream.read(&mut data) else { continue; };
        let request = String::from_utf8_lossy(&data[..count]);
        let path = request.split_whitespace().nth(1).unwrap_or("").split('?').next().unwrap_or("");
        let ok = path == home || path == health;
        let status = if ok { "200 OK" } else { "404 Not Found" };
        let body = format!("{{\"service\":\"rust-api\",\"ok\":{}}}", ok);
        let _ = write!(stream, "HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", status, body.len(), body);
    }
}
