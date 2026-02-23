#[cfg(windows)]
mod com_interfaces;
#[cfg(windows)]
mod dispatch_helpers;
#[cfg(windows)]
mod event_sink;
#[cfg(windows)]
mod manager;
#[cfg(windows)]
mod ole_container;
#[cfg(windows)]
mod session;
#[cfg(windows)]
mod sta_thread;
#[cfg(not(windows))]
mod manager_stub;

#[cfg(windows)]
pub use manager::{RdpActiveXEvent, RdpActiveXManager, RdpSessionConfig};
#[cfg(not(windows))]
pub use manager_stub::{RdpActiveXEvent, RdpActiveXManager, RdpSessionConfig};

#[cfg(any(windows, test))]
fn should_suppress_rdp_credential_prompt(
    username: Option<&str>,
    password: Option<&str>,
) -> bool {
    let has_username = username.is_some_and(|u| !u.is_empty());
    let has_password = password.is_some_and(|p| !p.is_empty());

    // Domain is optional/embedded in many environments; only require username + password.
    has_username && has_password
}

#[cfg(test)]
mod tests {
    use super::should_suppress_rdp_credential_prompt;

    #[test]
    fn suppresses_prompt_only_with_non_empty_username_and_password() {
        assert!(!should_suppress_rdp_credential_prompt(None, None));
        assert!(!should_suppress_rdp_credential_prompt(Some(""), Some("secret")));
        assert!(!should_suppress_rdp_credential_prompt(None, Some("secret")));
        assert!(!should_suppress_rdp_credential_prompt(Some("alice"), None));
        assert!(!should_suppress_rdp_credential_prompt(Some("alice"), Some("")));
        assert!(should_suppress_rdp_credential_prompt(
            Some("alice"),
            Some("secret")
        ));
    }
}
