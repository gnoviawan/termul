use super::consent::HostMount;
use super::convert::McpCatalogReason;
use super::launch_check::{check_stdio_launch, host_mounts, runs_inline_code};

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).to_string()).collect()
}

fn check(command: &str, args: &[&str]) -> Result<(), McpCatalogReason> {
    check_stdio_launch(command, &strings(args))
}

fn argument(command: &str, argument: &str) -> McpCatalogReason {
    McpCatalogReason::UnsupportedLaunchArgument {
        command: command.to_string(),
        argument: argument.to_string(),
    }
}

fn runner(command: &str) -> McpCatalogReason {
    McpCatalogReason::UnsupportedRunner {
        command: command.to_string(),
    }
}

#[test]
fn a_runner_behind_a_pass_through_wrapper_must_take_the_template_shape() {
    for (command, args, reason) in [
        ("nice", vec!["-n", "5", "npx", "--registry", "https://evil.example", "ok"], argument("npx", "--registry")),
        ("timeout", vec!["30", "uvx", "--index-url", "https://evil.example", "t"], argument("uvx", "--index-url")),
        ("timeout", vec!["-k", "5", "--signal=TERM", "30", "npx", "-p", "x", "ok"], argument("npx", "-p")),
        ("stdbuf", vec!["-oL", "npx", "--registry=https://evil.example", "ok"], argument("npx", "--registry=https://evil.example")),
        ("setsid", vec!["-w", "docker", "run", "--privileged", "ghcr.io/a/b:1.0"], argument("docker", "--privileged")),
        ("sudo", vec!["-u", "mcp", "dotnet", "dnx", "X@1.0.0", "--yes", "--add-source", "x"], argument("dotnet", "--add-source")),
        ("doas", vec!["-u", "mcp", "npx", "--registry", "x", "ok"], argument("npx", "--registry")),
        ("xargs", vec!["-0", "npx", "--registry", "x", "ok"], argument("npx", "--registry")),
        ("busybox", vec!["env", "FOO=1", "npx", "--registry", "x", "ok"], argument("npx", "--registry")),
        ("/bin/busybox", vec!["nohup", "uvx", "--with", "x", "t"], argument("uvx", "--with")),
        ("env", vec!["nice", "timeout", "5", "npx", "-p", "x", "ok"], argument("npx", "-p")),
        ("npx.", vec!["--registry=x", "ok"], argument("npx", "--registry=x")),
        ("C:\\nodejs\\NPX.CMD.", vec!["--registry=x", "ok"], argument("npx", "--registry=x")),
        ("sudo", vec!["-s", "node"], argument("sudo", "-s")),
        ("sudo", vec!["--preserve-env=NODE_OPTIONS", "node"], argument("sudo", "--preserve-env=NODE_OPTIONS")),
        ("doas", vec!["-s"], argument("doas", "-s")),
        ("xargs", vec!["-I", "{}", "npx", "{}"], argument("xargs", "-I")),
        ("timeout", vec!["--foo", "5", "node"], argument("timeout", "--foo")),
        ("busybox", vec!["--install"], argument("busybox", "--install")),
        ("nice", vec!["-10", "node"], argument("nice", "-10")),
        ("timeout", vec!["5"], McpCatalogReason::InvalidCommand),
        (
            "sudo",
            vec!["NODE_OPTIONS=--require=./x.js", "node"],
            McpCatalogReason::DeniedEnv { name: "NODE_OPTIONS".to_string() },
        ),
        (
            "env.exe",
            vec!["nohup", "npx.cmd.", "-y", "ok@1.0.0", "a&b"],
            McpCatalogReason::CmdMetacharacter { field: "args[4]".to_string() },
        ),
    ] {
        assert_eq!(check(command, &args), Err(reason), "{command} {args:?}");
    }
    for (command, args) in [
        ("nice", vec!["-n", "5", "npx", "-y", "ok@1.0.0"]),
        ("nice", vec!["--adjustment=5", "node", "srv.js"]),
        ("timeout", vec!["--preserve-status", "30", "uvx", "tool@1.0"]),
        ("sudo", vec!["-E", "-u", "mcp", "FOO=1", "node", "srv.js"]),
        ("busybox", vec!["timeout", "30", "node", "srv.js"]),
        ("stdbuf", vec!["-o", "L", "-eL", "node", "srv.js"]),
        ("setsid", vec!["--wait", "node", "srv.js"]),
        ("xargs", vec!["-r", "-n", "1", "node", "srv.js"]),
    ] {
        assert_eq!(check(command, &args), Ok(()), "{command} {args:?}");
    }
}

#[test]
fn a_runner_alias_takes_its_template_shape_or_is_unsupported() {
    for (command, args, reason) in [
        ("npm", vec!["exec", "--", "ok@1.0.0"], runner("npm exec")),
        ("npm", vec!["x", "ok"], runner("npm x")),
        ("npm", vec!["exe", "-y", "ok"], runner("npm exe")),
        ("npm", vec!["init", "evil"], runner("npm init")),
        ("npm", vec!["--yes", "cre", "evil"], runner("npm cre")),
        ("pnpm", vec!["create", "evil"], runner("pnpm create")),
        ("yarn", vec!["create", "evil"], runner("yarn create")),
        ("bun", vec!["create", "evil"], runner("bun create")),
        ("npm", vec!["--yes", "exec", "-c", "node -e 1"], runner("npm exec")),
        ("pnpm", vec!["dlx", "ok"], runner("pnpm dlx")),
        ("pnpm", vec!["exec", "ok"], runner("pnpm exec")),
        ("yarn", vec!["dlx", "ok"], runner("yarn dlx")),
        ("bunx", vec!["ok"], runner("bunx")),
        ("bun", vec!["x", "ok"], runner("bun x")),
        ("pnpx", vec!["ok"], runner("pnpx")),
        ("uv", vec!["run", "--with", "evil", "python", "srv.py"], runner("uv run --with")),
        ("uv", vec!["run", "--with-requirements=r.txt", "srv.py"], runner("uv run --with")),
        ("uv", vec!["tool", "install", "t"], argument("uv tool", "install")),
        ("uv", vec!["tool", "run", "--index-url", "x", "t"], argument("uv tool run", "--index-url")),
        ("dnx", vec!["X@1.0.0", "--yes", "--add-source", "x"], argument("dnx", "--add-source")),
        ("dnx.cmd", vec!["X@1.0.0", "--yes", "@evil.rsp"], argument("dnx", "@evil.rsp")),
    ] {
        assert_eq!(check(command, &args), Err(reason), "{command} {args:?}");
    }
    for (command, args) in [
        ("uv", vec!["tool", "run", "mcp-server-fetch@1.0", "--flag"]),
        ("dnx", vec!["X@1.0.0", "--yes", "--", "--port", "1"]),
        ("uv", vec!["--directory", "/srv/mcp", "run", "server.py"]),
        ("npm", vec!["run", "start"]),
        ("bun", vec!["run", "srv.ts"]),
    ] {
        assert_eq!(check(command, &args), Ok(()), "{command} {args:?}");
    }
}

#[test]
fn inline_code_is_found_through_wrappers_and_runners() {
    for (command, args, inline) in [
        ("sudo", vec!["-u", "mcp", "bash", "-c", "x"], true),
        ("busybox", vec!["sh", "-c", "x"], true),
        ("timeout", vec!["5", "node", "-e", "x"], true),
        ("nice", vec!["-n", "1", "python3", "-c", "x"], true),
        ("env", vec!["FOO=1", "nohup", "perl", "-e", "x"], true),
        ("npm", vec!["exec", "-c", "node srv.js"], true),
        ("npm", vec!["x", "--call=node srv.js"], true),
        ("npm", vec!["exe", "-c", "node srv.js"], true),
        ("npx", vec!["-y", "node@20", "-e", "x"], true),
        ("uvx", vec!["python@3.12", "-c", "x"], true),
        ("uv", vec!["tool", "run", "python", "-c", "x"], true),
        ("npx", vec!["-y", "ok@1.0.0", "-e", "x"], false),
        ("timeout", vec!["5", "node", "srv.js"], false),
        ("npm", vec!["run", "start", "-c"], false),
    ] {
        assert_eq!(runs_inline_code(command, &strings(&args)), inline, "{command} {args:?}");
    }
}

fn mount(host_path: &str, sensitive: bool) -> HostMount {
    HostMount {
        host_path: host_path.to_string(),
        sensitive,
    }
}

#[test]
fn every_docker_host_mount_is_named_and_root_home_and_socket_are_sensitive() {
    let docker = |volumes: &[&str]| {
        let mut args = vec!["run", "-i", "--rm"];
        for volume in volumes {
            args.extend(["-v", volume]);
        }
        args.push("ghcr.io/a/b:1.0");
        host_mounts("docker", &strings(&args))
    };
    assert_eq!(
        docker(&[
            "/srv/data:/data",
            "/:/host",
            "/var/run/docker.sock:/var/run/docker.sock",
            "/run:/run",
            "/home/alice:/h:ro",
            "/Users/alice/:/h",
            "C:\\Users\\alice:/h",
            "/root:/r",
            "~:/h",
            "/tmp/../:/x",
            "/home/alice/project:/p",
            "./data:/data",
            "cache:/cache",
            "/anonymous",
        ]),
        vec![
            mount("/srv/data", false),
            mount("/", true),
            mount("/var/run/docker.sock", true),
            mount("/run", true),
            mount("/home/alice", true),
            mount("/Users/alice/", true),
            mount("C:\\\\Users\\\\alice", true),
            mount("/root", true),
            mount("~", true),
            mount("/tmp/../", true),
            mount("/home/alice/project", false),
            mount("./data", false),
        ]
    );
    assert_eq!(
        host_mounts(
            "sudo",
            &strings(&["docker", "run", "--volume=//./pipe/docker_engine://./pipe/docker_engine", "img:1"])
        ),
        vec![mount("//./pipe/docker_engine", true)]
    );
    assert_eq!(host_mounts("node", &strings(&["-v", "/:/x"])), vec![]);
}

#[test]
fn an_imported_npm_spec_naming_a_tarball_is_refused_as_in_the_catalog() {
    for spec in ["ok@1.0.0-evil.tgz", "ok@1.0.0-a.TAR.GZ", "@scope/ok@2.0.0-x.tar"] {
        assert_eq!(
            check("npx", &["-y", spec]),
            Err(McpCatalogReason::InvalidPackage),
            "{spec}"
        );
    }
    assert_eq!(check("npx", &["-y", "ok@1.0.0-rc.1"]), Ok(()));
}
