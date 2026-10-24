//! The Rat Things mark, rendered by `scripts/build-brand-marks.mjs`. See BRAND.md.

const APP_ICON_PNG: &[u8] = include_bytes!("../assets/brand/app-icon-256.png");
const GLYPH_PNG: &[u8] = include_bytes!("../assets/brand/glyph-96.png");

/// The window and Dock icon used when the console runs outside an app bundle.
pub fn app_icon() -> egui::IconData {
    eframe::icon_data::from_png_bytes(APP_ICON_PNG).expect("the embedded app icon is a valid PNG")
}

/// The glyph beside the product name, uploaded once per context.
pub(crate) fn glyph(ctx: &egui::Context) -> egui::TextureHandle {
    let id = egui::Id::new("rat-things-glyph");
    if let Some(texture) = ctx.data(|data| data.get_temp::<egui::TextureHandle>(id)) {
        return texture;
    }
    let icon =
        eframe::icon_data::from_png_bytes(GLYPH_PNG).expect("the embedded glyph is a valid PNG");
    let image = egui::ColorImage::from_rgba_unmultiplied(
        [icon.width as usize, icon.height as usize],
        &icon.rgba,
    );
    let texture = ctx.load_texture("rat-things-glyph", image, egui::TextureOptions::LINEAR);
    ctx.data_mut(|data| data.insert_temp(id, texture.clone()));
    texture
}
