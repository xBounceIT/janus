use ironrdp_input::{MouseButton, MousePosition, Operation, Scancode, WheelRotations};

/// Translate a mouse event from the frontend into ironrdp operations.
///
/// `buttons` is a bitmask matching web MouseEvent.buttons:
///   bit 0 = left, bit 1 = right, bit 2 = middle, bit 3 = x1, bit 4 = x2
///
/// `prev_buttons` is the previous button state to detect presses/releases.
pub fn translate_mouse(
    x: u16,
    y: u16,
    buttons: u8,
    prev_buttons: u8,
    wheel_delta: i16,
) -> Vec<Operation> {
    let mut ops = Vec::new();

    // Always emit a mouse move
    ops.push(Operation::MouseMove(MousePosition { x, y }));

    // Check each button for press/release transitions
    let button_map: [(u8, MouseButton); 5] = [
        (0x01, MouseButton::Left),
        (0x02, MouseButton::Right),
        (0x04, MouseButton::Middle),
        (0x08, MouseButton::X1),
        (0x10, MouseButton::X2),
    ];

    for (mask, button) in &button_map {
        let was_pressed = prev_buttons & mask != 0;
        let is_pressed = buttons & mask != 0;

        if is_pressed && !was_pressed {
            ops.push(Operation::MouseButtonPressed(*button));
        } else if !is_pressed && was_pressed {
            ops.push(Operation::MouseButtonReleased(*button));
        }
    }

    // Wheel
    if wheel_delta != 0 {
        ops.push(Operation::WheelRotations(WheelRotations {
            is_vertical: true,
            rotation_units: wheel_delta,
        }));
    }

    ops
}

/// Translate a key event from the frontend into ironrdp operations.
///
/// `scancode` is a PS/2 scancode value.
/// `is_release` indicates key-up vs key-down.
/// `extended` indicates an extended scancode (0xE0 prefix).
pub fn translate_key(scancode: u16, extended: bool, is_release: bool) -> Operation {
    let sc = Scancode::from_u8(extended, scancode as u8);
    if is_release {
        Operation::KeyReleased(sc)
    } else {
        Operation::KeyPressed(sc)
    }
}
