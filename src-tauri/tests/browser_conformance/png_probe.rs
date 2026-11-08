//! Just enough PNG decoding to sample a screenshot's pixels: 8-bit RGB or
//! RGBA, not interlaced, which is what every engine's capture writes.

use std::io::Read;

pub struct Image {
    pub width: usize,
    pub height: usize,
    channels: usize,
    data: Vec<u8>,
}

impl Image {
    /// RGB of the pixel at `(x, y)`.
    pub fn rgb(&self, x: usize, y: usize) -> [u8; 3] {
        let at = (y * self.width + x) * self.channels;
        [self.data[at], self.data[at + 1], self.data[at + 2]]
    }

    /// Pixels of the `size`-square at each corner, `inset` px in from the
    /// edges, that are not near-white.
    pub fn non_white_corner_pixels(&self, size: usize, inset: usize) -> usize {
        let size = size.min(self.width / 4).min(self.height / 4);
        let xs = [inset, self.width.saturating_sub(inset + size)];
        let ys = [inset, self.height.saturating_sub(inset + size)];
        let mut count = 0;
        for &x0 in &xs {
            for &y0 in &ys {
                for y in y0..(y0 + size).min(self.height) {
                    for x in x0..(x0 + size).min(self.width) {
                        if self.rgb(x, y).iter().any(|&c| c < 245) {
                            count += 1;
                        }
                    }
                }
            }
        }
        count
    }
}

fn be32(bytes: &[u8]) -> usize {
    u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize
}

fn paeth(a: u8, b: u8, c: u8) -> u8 {
    let (a16, b16, c16) = (i16::from(a), i16::from(b), i16::from(c));
    let p = a16 + b16 - c16;
    let (pa, pb, pc) = ((p - a16).abs(), (p - b16).abs(), (p - c16).abs());
    if pa <= pb && pa <= pc {
        a
    } else if pb <= pc {
        b
    } else {
        c
    }
}

pub fn decode(bytes: &[u8]) -> Result<Image, String> {
    const SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    if bytes.len() < 8 || bytes[..8] != SIGNATURE {
        return Err("not a PNG".into());
    }
    let (mut at, mut header, mut idat) = (8, None, Vec::new());
    while at + 8 <= bytes.len() {
        let len = be32(&bytes[at..]);
        let kind = &bytes[at + 4..at + 8];
        let body = bytes.get(at + 8..at + 8 + len).ok_or("truncated chunk")?;
        match kind {
            b"IHDR" => header = Some(body.to_vec()),
            b"IDAT" => idat.extend_from_slice(body),
            b"IEND" => break,
            _ => {}
        }
        at += 12 + len;
    }
    let header = header.ok_or("no IHDR")?;
    let (width, height) = (be32(&header[0..]), be32(&header[4..]));
    let channels = match (header[8], header[9], header[12]) {
        (8, 2, 0) => 3,
        (8, 6, 0) => 4,
        other => return Err(format!("unsupported PNG layout {other:?}")),
    };
    let mut raw = Vec::new();
    flate2::read::ZlibDecoder::new(&idat[..])
        .read_to_end(&mut raw)
        .map_err(|e| format!("inflate: {e}"))?;
    let stride = width * channels;
    if raw.len() < height * (stride + 1) {
        return Err("short image data".into());
    }
    let mut data = vec![0u8; height * stride];
    for y in 0..height {
        let filter = raw[y * (stride + 1)];
        let line = &raw[y * (stride + 1) + 1..(y + 1) * (stride + 1)];
        for i in 0..stride {
            let left = if i >= channels { data[y * stride + i - channels] } else { 0 };
            let up = if y > 0 { data[(y - 1) * stride + i] } else { 0 };
            let up_left = if y > 0 && i >= channels { data[(y - 1) * stride + i - channels] } else { 0 };
            let predicted = match filter {
                0 => 0,
                1 => left,
                2 => up,
                3 => ((u16::from(left) + u16::from(up)) / 2) as u8,
                4 => paeth(left, up, up_left),
                other => return Err(format!("unknown filter {other}")),
            };
            data[y * stride + i] = line[i].wrapping_add(predicted);
        }
    }
    Ok(Image {
        width,
        height,
        channels,
        data,
    })
}
