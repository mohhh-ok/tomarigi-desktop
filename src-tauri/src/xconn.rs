// ---- X11 connection (Linux) ----
// One connection to the X server, shared by the fade (which mouse buttons are down; fade.rs) and the jump to the
// terminal window (focus/x11.rs). On a Wayland session the app runs through Xwayland (GDK_BACKEND=x11 in lib.rs), so
// DISPLAY is set there too. Without an X server everything here returns nothing

use std::sync::OnceLock;
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{ConnectionExt, KeyButMask, Window};
use x11rb::rust_connection::RustConnection;

pub(crate) struct X {
    pub(crate) conn: RustConnection,
    pub(crate) root: Window,
}

pub(crate) fn x() -> Option<&'static X> {
    static X_CONN: OnceLock<Option<X>> = OnceLock::new();
    X_CONN
        .get_or_init(|| {
            let (conn, screen) = x11rb::connect(None).ok()?;
            let root = conn.setup().roots.get(screen)?.root;
            Some(X { conn, root })
        })
        .as_ref()
}

/// Whether a mouse button (left, middle, right) is held
pub(crate) fn buttons_down() -> bool {
    let Some(x) = x() else { return false };
    let Some(reply) = x.conn.query_pointer(x.root).ok().and_then(|c| c.reply().ok()) else { return false };
    let held = KeyButMask::BUTTON1 | KeyButMask::BUTTON2 | KeyButMask::BUTTON3;
    u16::from(reply.mask) & u16::from(held) != 0
}
