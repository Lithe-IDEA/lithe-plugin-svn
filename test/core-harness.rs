//! Test-only bridge to Lithe's public JSON API; it contains no Subversion
//! semantics. A provider session lives inside Core, so one process answers
//! every request of a test: one JSON request per stdin line, one response
//! per stdout line. It exits when stdin closes.

use std::io::{BufRead, Write};

fn main() {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let request = line.expect("a UTF-8 request line");
        if request.trim().is_empty() {
            continue;
        }
        writeln!(stdout, "{}", lithe_core::execute_json(&request)).expect("write the response");
        stdout.flush().expect("flush the response");
    }
}
