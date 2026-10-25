//! WebView2 trusted input: CDP `Input.*` over the in-process DevTools
//! channel. It never moves Win32 focus: the chat webview keeps keyboard
//! focus while the agent tab receives the events.

use std::sync::Arc;

use super::super::cdp::{self, input as cdp_input};
use super::super::input::NativeInput;
use super::super::{CapabilityId, EngineFuture, KeyInput, Point, Support};
use super::WebView2Transport;
use crate::browser_tab_manager::BrowserTabManager;

const TIERS: &[(CapabilityId, Support)] = &[
    (CapabilityId::PointerClick, Support::Trusted),
    (CapabilityId::TrustedKey, Support::Trusted),
    (CapabilityId::PointerMove, Support::Trusted),
    (CapabilityId::Wheel, Support::Trusted),
    (CapabilityId::Drag, Support::Trusted),
];

pub struct CdpInput {
    transport: WebView2Transport,
}

impl CdpInput {
    pub fn new(tabs: Arc<BrowserTabManager>) -> Self {
        Self {
            transport: WebView2Transport { tabs },
        }
    }
}

impl NativeInput for CdpInput {
    fn tiers(&self) -> &'static [(CapabilityId, Support)] {
        TIERS
    }

    fn click<'a>(&'a self, tab: &'a str, at: Point) -> EngineFuture<'a, ()> {
        Box::pin(cdp::click_at(&self.transport, tab, at))
    }

    fn move_to<'a>(&'a self, tab: &'a str, at: Point) -> EngineFuture<'a, ()> {
        Box::pin(cdp_input::move_to(&self.transport, tab, at))
    }

    fn wheel<'a>(&'a self, tab: &'a str, at: Point, dx: f64, dy: f64) -> EngineFuture<'a, ()> {
        Box::pin(cdp_input::wheel(&self.transport, tab, at, dx, dy))
    }

    fn drag<'a>(&'a self, tab: &'a str, from: Point, to: Point) -> EngineFuture<'a, ()> {
        Box::pin(cdp_input::drag(&self.transport, tab, from, to))
    }

    fn key<'a>(&'a self, tab: &'a str, input: KeyInput<'a>) -> EngineFuture<'a, ()> {
        Box::pin(async move {
            match input {
                KeyInput::Text(text) => cdp_input::insert_text(&self.transport, tab, text).await,
                KeyInput::Press(key) => cdp_input::press(&self.transport, tab, key).await,
            }
        })
    }
}
