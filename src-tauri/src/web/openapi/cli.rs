//! `termul-server openapi [--format yaml|json]`: prints the spec to stdout.
//! Hidden from `--help`; release CI runs it to attach `openapi.yaml` to each
//! GitHub release. Builds the document from the compiled-in route table, so it
//! needs no state dir, no config and no running server.

use std::io::{ErrorKind, Write};
use std::process::ExitCode;

use super::document;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Yaml,
    Json,
}

const USAGE: &str = "usage: termul-server openapi [--format yaml|json]";

/// The `--format` choice from the arguments after `openapi`.
pub fn parse_format(args: &[String]) -> Result<Format, String> {
    let mut format = Format::Yaml;
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        let value = match arg.strip_prefix("--format=") {
            Some(value) => value,
            None if arg == "--format" => args.next().map(String::as_str).ok_or("--format needs a value")?,
            None => return Err(format!("unknown argument `{arg}`")),
        };
        format = match value {
            "yaml" => Format::Yaml,
            "json" => Format::Json,
            other => return Err(format!("unknown format `{other}` (expected yaml or json)")),
        };
    }
    Ok(format)
}

pub fn render(format: Format) -> String {
    let document = document();
    match format {
        Format::Yaml => serde_norway::to_string(&document).expect("a JSON value serializes as YAML"),
        Format::Json => {
            let mut json =
                serde_json::to_string_pretty(&document).expect("a JSON value serializes");
            json.push('\n');
            json
        }
    }
}

/// Runs the subcommand with the arguments that follow `openapi`.
pub fn run(args: &[String]) -> ExitCode {
    if args.iter().any(|arg| arg == "-h" || arg == "--help") {
        println!("{USAGE}");
        return ExitCode::SUCCESS;
    }
    match parse_format(args) {
        Ok(format) => match std::io::stdout().lock().write_all(render(format).as_bytes()) {
            Ok(()) => ExitCode::SUCCESS,
            // `termul-server openapi | head` closes the pipe early on purpose.
            Err(error) if error.kind() == ErrorKind::BrokenPipe => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("error: cannot write the spec: {error}");
                ExitCode::FAILURE
            }
        },
        Err(message) => {
            eprintln!("error: {message}\n{USAGE}");
            ExitCode::from(2)
        }
    }
}
