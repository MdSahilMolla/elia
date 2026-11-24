//! Sealed receipts: what a run was allowed, what it did, and a hash that makes
//! after-the-fact edits detectable. With ELIA_BOX_RECEIPT_KEY set the seal is also
//! an HMAC-SHA256, so only a holder of the key can produce a receipt that verifies.
//! Without it the hash catches accidents, not a determined forger; the receipt says
//! which of the two it carries.

use crate::fsx::sha256_hex;
use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};

pub const SCHEMA: &str = "elia-box.receipt/1";

/// Canonical JSON: serde_json's default map keeps keys sorted, so equal values
/// serialize to equal bytes.
pub fn canonical(v: &Value) -> String {
    serde_json::to_string(v).unwrap_or_default()
}

fn hex_to_bytes(h: &str) -> Vec<u8> {
    (0..h.len() / 2)
        .filter_map(|i| u8::from_str_radix(&h[2 * i..2 * i + 2], 16).ok())
        .collect()
}

pub fn hmac_sha256_hex(key: &[u8], msg: &[u8]) -> String {
    let mut k = if key.len() > 64 {
        hex_to_bytes(&sha256_hex(key))
    } else {
        key.to_vec()
    };
    k.resize(64, 0);
    let mut inner: Vec<u8> = k.iter().map(|b| b ^ 0x36).collect();
    inner.extend_from_slice(msg);
    let mut outer: Vec<u8> = k.iter().map(|b| b ^ 0x5c).collect();
    outer.extend_from_slice(&hex_to_bytes(&sha256_hex(&inner)));
    sha256_hex(&outer)
}

/// Adds `receiptHash` (and `receiptMac` when a key is given) to a receipt body.
pub fn seal(mut body: Value, key: Option<&[u8]>) -> Value {
    let text = canonical(&body);
    let obj = body.as_object_mut().expect("receipt is an object");
    obj.insert("receiptHash".into(), json!(sha256_hex(text.as_bytes())));
    if let Some(k) = key {
        obj.insert(
            "receiptMac".into(),
            json!(hmac_sha256_hex(k, text.as_bytes())),
        );
    }
    body
}

#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    /// Hash matches; no MAC to check.
    HashOk,
    /// Hash and MAC both match under the supplied key.
    MacOk,
    Bad(String),
}

pub fn verify(receipt: &Value, key: Option<&[u8]>) -> Verdict {
    let Some(obj) = receipt.as_object() else {
        return Verdict::Bad("not an object".into());
    };
    let mut body = obj.clone();
    let Some(hash) = body
        .remove("receiptHash")
        .and_then(|h| h.as_str().map(String::from))
    else {
        return Verdict::Bad("no receiptHash".into());
    };
    let mac = body
        .remove("receiptMac")
        .and_then(|h| h.as_str().map(String::from));
    let text = canonical(&Value::Object(body));
    if sha256_hex(text.as_bytes()) != hash {
        return Verdict::Bad("receiptHash does not match the contents".into());
    }
    match (mac, key) {
        (Some(m), Some(k)) if hmac_sha256_hex(k, text.as_bytes()) == m => Verdict::MacOk,
        (Some(_), Some(_)) => Verdict::Bad("receiptMac does not verify under this key".into()),
        (Some(_), None) => Verdict::HashOk,
        (None, Some(_)) => {
            Verdict::Bad("a key was supplied but the receipt carries no receiptMac".into())
        }
        (None, None) => Verdict::HashOk,
    }
}

/// RFC 3339 UTC timestamp with millisecond precision.
pub fn rfc3339(t: SystemTime) -> String {
    let d = t.duration_since(UNIX_EPOCH).unwrap_or_default();
    let (secs, ms) = (d.as_secs() as i64, d.subsec_millis());
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // civil-from-days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{ms:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hmac_matches_rfc4231_vectors() {
        // RFC 4231 test case 2
        assert_eq!(
            hmac_sha256_hex(b"Jefe", b"what do ya want for nothing?"),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        // RFC 4231 test case 6: a key longer than the block size
        assert_eq!(
            hmac_sha256_hex(
                &[0xaa; 131],
                b"Test Using Larger Than Block-Size Key - Hash Key First"
            ),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    #[test]
    fn seal_and_verify_detect_tampering() {
        let r = seal(json!({"schema": SCHEMA, "exit": {"code": 0}}), None);
        assert_eq!(verify(&r, None), Verdict::HashOk);
        let mut forged = r.clone();
        forged["exit"]["code"] = json!(1);
        assert!(matches!(verify(&forged, None), Verdict::Bad(_)));
    }

    #[test]
    fn mac_binds_the_receipt_to_the_key() {
        let r = seal(json!({"a": 1}), Some(b"secret"));
        assert_eq!(verify(&r, Some(b"secret")), Verdict::MacOk);
        assert!(matches!(verify(&r, Some(b"wrong")), Verdict::Bad(_)));
        // A forger without the key can recompute the hash but not the MAC.
        let mut forged = json!({"a": 2});
        let h = sha256_hex(canonical(&forged).as_bytes());
        forged["receiptHash"] = json!(h);
        forged["receiptMac"] = r["receiptMac"].clone();
        assert!(matches!(verify(&forged, Some(b"secret")), Verdict::Bad(_)));
    }

    #[test]
    fn timestamps_format() {
        assert_eq!(rfc3339(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            rfc3339(UNIX_EPOCH + std::time::Duration::from_millis(1_709_210_096_789)),
            "2024-02-29T12:34:56.789Z"
        );
    }
}
