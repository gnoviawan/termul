# Original Troupe bash integration (bash >=4.3; older shells stay raw).
__termul_session_id=${TERMUL_SESSION_ID-}
__termul_nonce=${TERMUL_SESSION_NONCE-}
export -n __termul_session_id __termul_nonce
unset TERMUL_SESSION_ID TERMUL_SESSION_NONCE

# Emulate login startup: --init-file is ignored by a login bash.
[ ! -r /etc/profile ] || . /etc/profile
for __termul_startup_file in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
    if [ -r "$__termul_startup_file" ]; then
        . "$__termul_startup_file"
        break
    fi
done
unset __termul_startup_file

# Original Troupe session protocol helpers.
__termul_prompt_generation=0
__termul_initialized=0
__termul_generator=0
__termul_user_command=0
__termul_last_status=0
__termul_prompt_suppressed=false
__termul_bindings_changed=0

# Return escaped JSON string content without spawning a child process.
__termul_json_escape() {
    local LC_ALL=C
    local value=$1 char piece
    __termul_escaped=
    while [ -n "$value" ]; do
        char=${value:0:1}
        value=${value:1}
        case "$char" in
            \\) piece='\\' ;;
            '"') piece='\"' ;;
            [$'\001'-$'\037']) printf -v piece '\\u%04x' "'$char" ;;
            *) piece=$char ;;
        esac
        __termul_escaped=$__termul_escaped$piece
    done
}

__termul_frame() {
    printf '\033]9477;%s\007' "$1"
}

__termul_preexec() {
    # Generator preexec path.
    case "$1" in
        __termul_complete\ *)
            __termul_generator=1
            return 0
            ;;
    esac
    # User preexec path.
    __termul_generator=0
    __termul_user_command=1
    local json
    __termul_json_escape "$__termul_nonce"
    printf -v json '{"type":"CommandStarted","nonce":"%s"}' "$__termul_escaped"
    __termul_frame "$json"
}

# DEBUG runs before the first command after a trusted prompt, then disarms.
__termul_debug_armed=0
__termul_old_debug_trap=$(trap -p DEBUG)
__termul_old_debug_command=
__termul_old_prompt_command=$(declare -p PROMPT_COMMAND 2>/dev/null)
if [ -n "$__termul_old_debug_trap" ]; then
    __termul_debug_definition=${__termul_old_debug_trap% DEBUG}
    eval "__termul_old_debug_command=${__termul_debug_definition#trap -- }"
    unset __termul_debug_definition
fi

__termul_debug() {
    local command=$1 previous_status=$2 input_line=$3
    # Cached prompt suffixes share the interactive input line of the prompt hook.
    # The next submitted command has a new line even when history is disabled.
    case "$command" in
        __termul_prompt|__termul_prompt\ *) __termul_prompt_line=$input_line ;;
    esac
    if [ "$__termul_debug_armed" = 1 ] && [ "$input_line" != "${__termul_prompt_line-}" ]; then
        __termul_debug_armed=0
        case "$command" in
            __termul_prompt|__termul_prompt\ *) ;;
            *) __termul_preexec "$command" ;;
        esac
    fi
    if [ -n "$__termul_old_debug_command" ]; then
        __termul_status "$previous_status"
        eval "$__termul_old_debug_command"
    fi
}

# Restore the command status before each user prompt command.
__termul_status() { return "$1"; }

__termul_user_prompt() {
    local command
    # A command-time assignment belongs to the user, not our previous prompt.
    if [ "$PS1" != "$__termul_installed_prompt" ]; then
        __termul_saved_prompt=$PS1
    fi
    if ! builtin printf -v PS1 '%s' "$__termul_saved_prompt" 2>/dev/null; then
        __termul_prompt_suppressed=false
        return 0
    fi
    for command in "${__termul_user_prompt_commands[@]}"; do
        __termul_status "$__termul_status"
        eval "$command"
    done
    __termul_saved_prompt=$PS1
}

__termul_restore_prompt() {
    PS1=$__termul_saved_prompt
}

# The tail executes at script scope, after user prompt functions have returned.
__termul_prompt_command='__termul_prompt; eval "$__termul_prompt_tail"'
__termul_prompt_tail='__termul_current_debug_trap=$(trap -p DEBUG)
__termul_capture_debug
trap '\''__termul_debug "$BASH_COMMAND" "$?" "$LINENO"'\'' DEBUG
# Arm at script scope even when a cached suffix replaces the visible PS1.
__termul_debug_armed=1'

__termul_capture_debug() {
    local definition
    if [ "$__termul_current_debug_trap" != "$__termul_owned_debug_trap" ]; then
        __termul_old_debug_command=
        if [ -n "$__termul_current_debug_trap" ]; then
            definition=${__termul_current_debug_trap% DEBUG}
            eval "__termul_old_debug_command=${definition#trap -- }"
        fi
    fi
}

__termul_reclaim_prompt() {
    local command part trimmed remainder
    __termul_prompt_suppressed=true
    if [ "${#PROMPT_COMMAND[@]}" = 1 ] && [ "${PROMPT_COMMAND[0]}" = "$__termul_prompt_command" ]; then
        return 0
    fi
    __termul_prompt_suppressed=false
    __termul_user_prompt_commands=()
    for command in "${PROMPT_COMMAND[@]}"; do
        command=${command//"$__termul_prompt_command"/}
        remainder=
        # Remove standalone integration entries without changing other code.
        while [ -n "$command" ]; do
            part=${command%%;*}
            if [ "$part" = "$command" ]; then
                command=
            else
                command=${command#*;}
            fi
            trimmed=${part#"${part%%[![:space:]]*}"}
            trimmed=${trimmed%"${trimmed##*[![:space:]]}"}
            case "$trimmed" in
                __termul_prompt|'eval "$__termul_prompt_tail"') ;;
                *) remainder=$remainder$part; [ -z "$command" ] || remainder=$remainder';' ;;
            esac
        done
        while :; do
            case "$remainder" in
                [[:space:]\;]*) remainder=${remainder#?} ;;
                *[[:space:]\;]) remainder=${remainder%?} ;;
                *) break ;;
            esac
        done
        [ -z "$remainder" ] || __termul_user_prompt_commands+=("$remainder")
    done
    unset PROMPT_COMMAND
    PROMPT_COMMAND=$__termul_prompt_command
}

__termul_prompt() {
    local __termul_status=$?
    local nonce_json session_json cwd_json json
    __termul_debug_armed=0
    if [ "$__termul_generator" = 1 ]; then
        __termul_generator=0
        return 0
    fi
    __termul_last_status=$__termul_status
    if [ "$__termul_user_command" = 1 ]; then
        __termul_user_command=0
        __termul_json_escape "$__termul_nonce"
        printf -v json '{"type":"CommandFinished","nonce":"%s","exit_code":%s}' "$__termul_escaped" "$__termul_status"
        __termul_frame "$json"
    fi
    __termul_reclaim_prompt
    __termul_user_prompt
    # Reclaim the private history exclusion without dropping user patterns.
    case :${HISTIGNORE-}: in
        *:__termul_complete\*:* ) ;;
        *) HISTIGNORE=${HISTIGNORE:+$HISTIGNORE:}'__termul_complete*' ;;
    esac
    __termul_saved_prompt=$PS1
    if [ "$__termul_prompt_suppressed" = true ]; then
        if (PS1='') 2>/dev/null && builtin printf -v PS1 '%s' '' 2>/dev/null; then
            :
        else
            __termul_prompt_suppressed=false
        fi
    fi
    __termul_json_escape "$__termul_nonce"
    nonce_json=$__termul_escaped
    if [ "$__termul_initialized" = 0 ]; then
        __termul_json_escape "$__termul_session_id"
        session_json=$__termul_escaped
        printf -v json '{"type":"InitShell","session_id":"%s","nonce":"%s"}' "$session_json" "$nonce_json"
        __termul_frame "$json"
        __termul_initialized=1
    fi
    __termul_prompt_generation=$((__termul_prompt_generation + 1))
    __termul_json_escape "$PWD"
    cwd_json=$__termul_escaped
    printf -v json '{"type":"PromptReady","nonce":"%s","prompt_generation":%s,"line_empty":true,"prompt_suppressed":%s,"cwd":"%s"}' "$nonce_json" "$__termul_prompt_generation" "$__termul_prompt_suppressed" "$cwd_json"
    builtin printf '\033]133;A;termul\007'
    __termul_frame "$json"
    __termul_installed_prompt=$PS1
}

# Encode candidate bytes, preserving first occurrence order and bounding the result.
__termul_completion_output() {
    local LC_ALL=C
    local candidate hex count=0 bytes=0 cost
    local newline='
'
    local seen=$newline
    while IFS= read -r candidate || [ -n "$candidate" ]; do
        candidate=${candidate% }
        [ -n "$candidate" ] || continue
        case "$seen" in
            *"$newline$candidate$newline"*) continue ;;
        esac
        seen=$seen$candidate$newline
        hex=$(printf '%s' "$candidate" | od -An -v -tx1 | tr -d ' \n')
        # Hex is JSON-safe; each separator expands to six bytes (\u000a).
        cost=$((${#hex} + 6))
        [ "$((bytes + cost))" -le "${__termul_completion_budget:-16000}" ] || break
        bytes=$((bytes + cost))
        printf '%s\n' "$hex"
        count=$((count + 1))
        [ "$count" -ge 200 ] && break
    done
}

# Reserve frame syntax and 1 KiB below MAX_SESSION_FRAME_BYTES (65536).
# A smaller output ceiling also bounds the cost of shell JSON escaping.
__termul_budget_completion() {
    local LC_ALL=C value
    __termul_completion_budget=64000
    for value in "$__termul_session_id" "$__termul_nonce" "$PWD" "$@" "$__termul_prompt_generation"; do
        __termul_json_escape "$value"
        __termul_completion_budget=$((__termul_completion_budget - ${#__termul_escaped}))
    done
    [ "$__termul_completion_budget" -le 16000 ] || __termul_completion_budget=16000
}

# Capture stdout only; stderr must never become a candidate or terminal output.
__termul_run_completer() {
    # Command substitution isolates bash completer CWD, exports and shell options.
    __termul_completion_candidates=$("$@" 2>/dev/null | __termul_completion_output)
}

# Internal transport helper for the in-band request entry point.
__termul_emit_completion() {
    local session_json nonce_json request_json cwd_json output_json json
    __termul_json_escape "$__termul_session_id"
    session_json=$__termul_escaped
    __termul_json_escape "$__termul_nonce"
    nonce_json=$__termul_escaped
    __termul_json_escape "$1"
    request_json=$__termul_escaped
    __termul_json_escape "$PWD"
    cwd_json=$__termul_escaped
    __termul_json_escape "$__termul_completion_candidates"
    output_json=$__termul_escaped
    printf -v json '{"type":"Completion","session_id":"%s","nonce":"%s","request_id":"%s","buffer_revision":%s,"cursor":%s,"prompt_generation":%s,"cwd":"%s","output":"%s"}' "$session_json" "$nonce_json" "$request_json" "$2" "$3" "$__termul_prompt_generation" "$cwd_json" "$output_json"
    __termul_frame "$json"
}

# Decode the request's hex draft without evaluating shell source.
__termul_decode_draft() {
    local value=$1 encoded=
    while [ -n "$value" ]; do
        encoded=$encoded"\x${value:0:2}"
        value=${value:2}
    done
    printf -v REPLY '%b' "$encoded"
}

# Preserve raw word spelling; only unquoted whitespace delimits COMP_WORDS.
# Never evaluate the draft, including substitutions and backtick expressions.
__termul_tokenize() {
    local draft=$1 word= quote= char escaped=0 trailing=0 i
    COMP_WORDS=()
    for ((i=0; i<${#draft}; i++)); do
        char=${draft:i:1}
        if [ "$escaped" = 1 ]; then
            word=$word$char
            escaped=0
        elif [ "$quote" = single ]; then
            word=$word$char
            [ "$char" != "'" ] || quote=
        elif [ "$quote" = double ]; then
            word=$word$char
            case "$char" in
                '"') quote= ;;
                \\) escaped=1 ;;
            esac
        else
            case "$char" in
                [[:space:]])
                    [ -z "$word" ] || COMP_WORDS+=("$word")
                    word= trailing=1
                    continue
                    ;;
                "'") quote=single ;;
                '"') quote=double ;;
                \\) escaped=1 ;;
            esac
            word=$word$char
        fi
        trailing=0
    done
    [ -z "$word" ] || COMP_WORDS+=("$word")
    [ "$trailing" = 0 ] || COMP_WORDS+=('')
    ((${#COMP_WORDS[@]})) || COMP_WORDS=('')
}

# Completion runs in a subshell: user completers cannot change shell state.
__termul_candidates() {
    local LC_ALL=C
    local draft=$1 word command spec function candidate previous
    local -a COMP_WORDS COMPREPLY
    __termul_tokenize "$draft"
    local COMP_CWORD=$((${#COMP_WORDS[@]} - 1))
    local COMP_LINE=$draft COMP_POINT=${#draft} COMP_TYPE=9 COMP_KEY=9
    word=${COMP_WORDS[COMP_CWORD]}
    command=${COMP_WORDS[0]}
    previous=
    ((COMP_CWORD == 0)) || previous=${COMP_WORDS[COMP_CWORD-1]}
    if ! complete -p -- "$command" >/dev/null 2>&1; then
        for candidate in /usr/share/bash-completion/bash_completion /opt/homebrew/etc/profile.d/bash_completion.sh /usr/local/etc/profile.d/bash_completion.sh; do
            if [ -r "$candidate" ]; then
                . "$candidate" >/dev/null 2>&1
                break
            fi
        done
        if declare -F _completion_loader >/dev/null; then
            _completion_loader "$command" >/dev/null 2>&1
        fi
    fi
    spec=$(complete -p -- "$command" 2>/dev/null)
    function=
    if [[ $spec =~ [[:space:]]-F[[:space:]]+([^[:space:]]+) ]]; then
        function=${BASH_REMATCH[1]}
    fi
    if [ -n "$function" ]; then
        "$function" "$command" "$word" "$previous" >/dev/null 2>&1
        printf '%s\n' "${COMPREPLY[@]}"
    elif ((COMP_CWORD == 0)); then
        compgen -c -- "$word"
    else
        compgen -f -- "$word"
    fi
}

__termul_complete() {
    local saved_status=$__termul_last_status
    local request_id=$1 buffer_revision=$2 cursor=$3 draft_hex=$4 REPLY
    __termul_budget_completion "$request_id" "$buffer_revision" "$cursor"
    __termul_completion_candidates=
    __termul_decode_draft "$draft_hex"
    __termul_run_completer __termul_candidates "$REPLY"
    __termul_emit_completion "$request_id" "$buffer_revision" "$cursor"
    return "$saved_status"
}

# Save bindings before installation so a partial bootstrap can roll back.
__termul_save_bindings() {
    __termul_old_0=$(bind -m emacs -p) || return 1
    __termul_old_1=$(bind -m vi-insert -p) || return 1
    __termul_old_2=$(bind -m vi-command -p) || return 1
    __termul_old_s_0=$(bind -m emacs -s) || return 1
    __termul_old_s_1=$(bind -m vi-insert -s) || return 1
    __termul_old_s_2=$(bind -m vi-command -s) || return 1
    __termul_old_x_0=$(bind -m emacs -X) || return 1
    __termul_old_x_1=$(bind -m vi-insert -X) || return 1
    __termul_old_x_2=$(bind -m vi-command -X) || return 1
}

# Replay the dumped bindings of the two keys bootstrap rebinds. Not `bind -f`:
# bash backs small here-strings with a pipe, which readline reads as empty.
# Not the whole dump either: replayed `\M-` lines rebind ESC prefixes.
__termul_replay_bindings() {
    local map=$1 binding
    while IFS= read -r binding; do
        case $binding in
            '"\e[99;1~"'* | '"\e[99;2~"'*) bind -m "$map" ${2:+"$2"} "$binding" ;;
        esac
    done <<< "$3"
}

# Restore the function, macro and shell-command dumps with one shared path.
__termul_restore_map() {
    __termul_replay_bindings "$1" '' "$2"
    __termul_replay_bindings "$1" '' "$3"
    __termul_replay_bindings "$1" -x "$4"
}

__termul_restore_bindings() {
    [ "$__termul_bindings_changed" = 1 ] || return 0
    local pair index map functions macros commands
    for pair in 0:emacs 1:vi-insert 2:vi-command; do
        index=${pair%%:*}
        map=${pair#*:}
        functions=__termul_old_$index
        macros=__termul_old_s_$index
        commands=__termul_old_x_$index
        [ "${!functions+set}" = set ] || continue
        bind -m "$map" -r '\e[99;1~'
        bind -m "$map" -r '\e[99;2~'
        __termul_restore_map "$map" "${!functions}" "${!macros-}" "${!commands-}"
    done
    if [ -n "${__termul_old_enable_bracketed_paste-}" ]; then
        builtin bind "set enable-bracketed-paste $__termul_old_enable_bracketed_paste" 2>/dev/null
    fi
}

# bash < 4.3 stays raw because there is no `bind -X` to snapshot `-x` bindings.
__termul_bind_clear_line() {
    bind -m emacs '"\e[99;1~": kill-whole-line' || return 1
    bind -m vi-insert '"\e[99;1~": kill-whole-line' || return 1
    # 0Di kills the line and enters insert so a following draft is typed, not
    # executed as vi-command motions. Independent of bracketed paste.
    bind -m vi-command '"\e[99;1~": "0Di"' || return 1
}

__termul_bind_restore_prompt() {
    bind -m emacs -x '"\e[99;2~": __termul_restore_prompt' || return 1
    bind -m vi-insert -x '"\e[99;2~": __termul_restore_prompt' || return 1
    bind -m vi-command -x '"\e[99;2~": __termul_restore_prompt' || return 1
}

__termul_bootstrap() {
    [ "${BASH_VERSINFO[0]}" -gt 4 ] || {
        [ "${BASH_VERSINFO[0]}" -eq 4 ] && [ "${BASH_VERSINFO[1]}" -ge 3 ]
    } || return 1
    [ -n "$__termul_session_id" ] && [ -n "$__termul_nonce" ] || return 1
    case $- in *i*) ;; *) return 1 ;; esac
    (unset PS1 PROMPT_COMMAND) 2>/dev/null || return 1
    shopt -q promptvars || return 1
    builtin printf -v __termul_probe '%s' '' || return 1
    unset __termul_probe
    [ "$__termul_debug_installed" = 1 ] || return 1
    __termul_save_bindings || return 1
    HISTIGNORE=${HISTIGNORE:+$HISTIGNORE:}'__termul_complete*'
    __termul_saved_prompt=$PS1
    __termul_installed_prompt=$PS1
    __termul_user_prompt_commands=("${PROMPT_COMMAND[@]}")
    unset PROMPT_COMMAND
    PROMPT_COMMAND=$__termul_prompt_command || return 1
    # Complete prompt checks and assignments before the first binding mutation.
    __termul_bindings_changed=1
    __termul_bind_clear_line || return 1
    __termul_bind_restore_prompt || return 1
    # Enable bracketed paste where bash supports it. The host wraps a submit
    # only after it sees CSI ?2004h; without that mode a multiline draft runs
    # line by line (same limitation as Warp).
    case $'\n'"$(builtin bind -v 2>/dev/null)"$'\n' in
        *$'\n'"set enable-bracketed-paste off"$'\n'*)
            __termul_old_enable_bracketed_paste=off
            builtin bind 'set enable-bracketed-paste on' 2>/dev/null
            ;;
        *$'\n'"set enable-bracketed-paste on"$'\n'*)
            __termul_old_enable_bracketed_paste=on
            builtin bind 'set enable-bracketed-paste on' 2>/dev/null
            ;;
    esac
    __termul_prompt_suppressed=true
}

# Install at script scope: bash restores an existing DEBUG trap on function return.
__termul_debug_installed=0
trap '__termul_debug "$BASH_COMMAND" "$?" "$LINENO"' DEBUG && __termul_debug_installed=1
__termul_owned_debug_trap=$(trap -p DEBUG)

# Bootstrap failure: keep the current shell.
__termul_bootstrap || {
    if [ -n "$__termul_old_debug_trap" ]; then
        eval "$__termul_old_debug_trap"
    else
        trap - DEBUG
    fi
    unset PROMPT_COMMAND
    if [ -n "$__termul_old_prompt_command" ]; then
        eval "$__termul_old_prompt_command"
    fi
    __termul_restore_bindings 2>/dev/null
    unset __termul_bindings_changed __termul_old_0 __termul_old_1 __termul_old_2
    unset __termul_old_s_{0,1,2} __termul_old_x_{0,1,2}
    unset __termul_old_enable_bracketed_paste
    # Rollback must remove the startup tree before forgetting the session ID.
    __termul_startup_directory=${BASH_SOURCE[0]%/*}
    if [ "${__termul_startup_directory##*/}" = "termul-shell-$__termul_session_id" ]; then
        command rm -rf -- "$__termul_startup_directory"
    fi
    unset __termul_startup_directory
    unset __termul_session_id __termul_nonce
    unset __termul_prompt_line __termul_debug_armed __termul_debug_installed __termul_old_debug_trap __termul_old_debug_command
    unset __termul_saved_prompt __termul_installed_prompt __termul_user_prompt_commands
    unset __termul_old_prompt_command __termul_prompt_command __termul_prompt_tail
    unset __termul_owned_debug_trap __termul_current_debug_trap
    unset __termul_user_command __termul_last_status
    unset __termul_prompt_generation __termul_initialized __termul_generator __termul_prompt_suppressed
    unset -f __termul_{complete,candidates,tokenize,decode_draft,prompt,debug,status,budget_completion,run_completer,completion_output,emit_completion,user_prompt,restore_prompt,preexec,frame,json_escape,bootstrap,save_bindings,restore_bindings,restore_map,replay_bindings,bind_clear_line,bind_restore_prompt,reclaim_prompt,capture_debug}
    return 0
}
unset __termul_bindings_changed __termul_old_0 __termul_old_1 __termul_old_2
unset __termul_old_s_{0,1,2} __termul_old_x_{0,1,2}
unset __termul_old_enable_bracketed_paste

# The init file is fully loaded; remove only this session's private startup tree.
__termul_startup_directory=${BASH_SOURCE[0]%/*}
if [ "${__termul_startup_directory##*/}" = "termul-shell-$__termul_session_id" ]; then
    command rm -rf -- "$__termul_startup_directory"
fi
unset __termul_startup_directory
