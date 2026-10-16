use serde_json::json;

use super::derive_title;

fn title_of(text: &str) -> String {
    derive_title(&json!({ "content": [{ "type": "text", "text": text }] }))
}

#[test]
fn a_skill_framed_prompt_titles_from_the_user_text() {
    assert_eq!(
        title_of("# Agent Skills\n\ngit-worktree: /skills/git-worktree/SKILL.md\n\n---\n\nmake a worktree with (git-worktree)"),
        "make a worktree with (git-worktree)"
    );
}

#[test]
fn a_command_prefixed_skill_prompt_keeps_the_command() {
    assert_eq!(
        title_of("/review # Agent Skills\n\nCafé-review: C:/skills/cafe/SKILL.md\n\n---\n\n(Café-review) the login form"),
        "/review (Café-review) the login form"
    );
}

#[test]
fn a_crlf_framed_prompt_titles_from_the_user_text() {
    assert_eq!(
        title_of(
            "# Agent Skills\r\n\r\ngit-worktree: /a/SKILL.md\r\n\r\n---\r\n\r\n(git-worktree) hi"
        ),
        "(git-worktree) hi"
    );
}

#[test]
fn a_token_only_skill_prompt_titles_from_the_framed_names() {
    assert_eq!(
        title_of("# Agent Skills\n\ngit-worktree: /a/SKILL.md\nrelease-version: /b/SKILL.md"),
        "(git-worktree) (release-version)"
    );
}

#[test]
fn text_that_only_resembles_the_framing_keeps_its_first_line() {
    assert_eq!(
        title_of("# Agent Skills\n\nnot a skill line\n\n---\n\nhello"),
        "# Agent Skills"
    );
    assert_eq!(title_of("/compact hello"), "/compact hello");
}

#[test]
fn a_framed_handoff_draft_with_skills_titles_from_the_user_text() {
    assert_eq!(
        title_of("# Conversation handoff\n\nYou are taking over.\n\n---\n\n# Agent Skills\n\nfix-repo: /skills/fix-repo.md\n\n---\n\n(fix-repo) now"),
        "(fix-repo) now"
    );
}
