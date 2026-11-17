use crate::storage::ImageFormat;
use std::path::PathBuf;
use std::io::Read;


pub fn extract_dimensions_from_bytes(data: &[u8], format: &ImageFormat) -> Option<(u32, u32)> {
    match format {
        ImageFormat::Png => extract_png_dimensions(data),
        ImageFormat::Jpeg => extract_jpeg_dimensions(data),
        ImageFormat::Gif => extract_gif_dimensions(data),
        ImageFormat::Webp => extract_webp_dimensions(data),
        ImageFormat::Bmp => extract_bmp_dimensions(data),
    }
}

pub fn extract_dimensions_from_file(path: &PathBuf, format: &ImageFormat) -> std::io::Result<Option<(u32, u32)>> {
    use std::fs::File;
    
    let mut file = File::open(path)?;
    
    let bytes_needed = match format {
        ImageFormat::Png => 24,
        ImageFormat::Jpeg => 65536,
        ImageFormat::Gif => 10,
        ImageFormat::Webp => 30,
        ImageFormat::Bmp => 26,
    };
    
    let mut buffer = vec![0u8; bytes_needed];
    let bytes_read = file.read(&mut buffer)?;
    buffer.truncate(bytes_read);
    
    Ok(extract_dimensions_from_bytes(&buffer, format))
}

fn extract_png_dimensions(data: &[u8]) -> Option<(u32, u32)> {
    if data.len() < 24 {
        return None;
    }
    
    if &data[0..8] != &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] {
        return None;
    }
    
    let width = u32::from_be_bytes([data[16], data[17], data[18], data[19]]);
    let height = u32::from_be_bytes([data[20], data[21], data[22], data[23]]);
    
    Some((width, height))
}

fn extract_jpeg_dimensions(data: &[u8]) -> Option<(u32, u32)> {
    if data.len() < 2 || data[0] != 0xFF || data[1] != 0xD8 {
        return None;
    }
    
    let mut pos = 2;
    
    while pos < data.len() - 9 {
        if data[pos] != 0xFF {
            return None;
        }
        
        let marker = data[pos + 1];
        pos += 2;
        
        if (0xC0..=0xCF).contains(&marker) && marker != 0xC4 && marker != 0xC8 && marker != 0xCC {
            if pos + 5 > data.len() {
                return None;
            }
            let height = u16::from_be_bytes([data[pos + 3], data[pos + 4]]) as u32;
            let width = u16::from_be_bytes([data[pos + 5], data[pos + 6]]) as u32;
            return Some((width, height));
        }
        
        if pos + 2 > data.len() {
            return None;
        }
        let length = u16::from_be_bytes([data[pos], data[pos + 1]]) as usize;
        pos += length;
    }
    
    None
}

fn extract_gif_dimensions(data: &[u8]) -> Option<(u32, u32)> {
    if data.len() < 10 {
        return None;
    }
    
    if &data[0..3] != b"GIF" {
        return None;
    }
    
    let width = u16::from_le_bytes([data[6], data[7]]) as u32;
    let height = u16::from_le_bytes([data[8], data[9]]) as u32;
    
    Some((width, height))
}

fn extract_webp_dimensions(data: &[u8]) -> Option<(u32, u32)> {
    if data.len() < 30 {
        return None;
    }
    
    if &data[0..4] != b"RIFF" || &data[8..12] != b"WEBP" {
        return None;
    }
    
    if &data[12..16] == b"VP8 " && data.len() >= 30 {
        let width = (u16::from_le_bytes([data[26], data[27]]) & 0x3FFF) as u32;
        let height = (u16::from_le_bytes([data[28], data[29]]) & 0x3FFF) as u32;
        return Some((width, height));
    }
    
    if &data[12..16] == b"VP8L" && data.len() >= 25 {
        let bits = u32::from_le_bytes([data[21], data[22], data[23], data[24]]);
        let width = ((bits & 0x3FFF) + 1) as u32;
        let height = (((bits >> 14) & 0x3FFF) + 1) as u32;
        return Some((width, height));
    }
    
    if &data[12..16] == b"VP8X" && data.len() >= 30 {
        let width = (u32::from_le_bytes([data[24], data[25], data[26], 0]) + 1) as u32;
        let height = (u32::from_le_bytes([data[27], data[28], data[29], 0]) + 1) as u32;
        return Some((width, height));
    }
    
    None
}

fn extract_bmp_dimensions(data: &[u8]) -> Option<(u32, u32)> {
    if data.len() < 26 {
        return None;
    }
    
    if &data[0..2] != b"BM" {
        return None;
    }
    
    let dib_header_size = u32::from_le_bytes([data[14], data[15], data[16], data[17]]);
    
    if dib_header_size == 40 {
        let width = u32::from_le_bytes([data[18], data[19], data[20], data[21]]);
        let height = i32::from_le_bytes([data[22], data[23], data[24], data[25]]).abs() as u32;
        return Some((width, height));
    }
    
    None
}

