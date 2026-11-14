# Original Troupe zsh integration; sourced by the final login shim.
typeset +x __termul_session_id __termul_nonce
__termul_session_id=${__termul_session_id-${TERMUL_SESSION_ID-}}
__termul_nonce=${__termul_nonce-${TERMUL_SESSION_NONCE-}}
unset TERMUL_SESSION_ID TERMUL_SESSION_NONCE TERMUL_USER_ZDOTDIR

# Original Troupe session protocol helpers.
__termul_prompt_generation=0
__termul_initialized=0
__termul_generator=0
__termul_user_command=0
__termul_last_status=0
__termul_prompt_suppressed=false

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

__termul_restore_prompt() {
    PROMPT=$__termul_saved_prompt
    RPROMPT=$__termul_saved_rprompt
    zle reset-prompt
}

__termul_prompt() {
    local __termul_status=$?
    local nonce_json session_json cwd_json json
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
    # A later user hook makes this prompt untrusted; repair the next ordering.
    __termul_prompt_suppressed=true
    if [[ ${precmd_functions[-1]} != __termul_prompt ]]; then
        __termul_prompt_suppressed=false
        precmd_functions=("${(@)precmd_functions:#__termul_prompt}" __termul_prompt)
    fi
    if [[ -n $PROMPT || $__termul_initialized = 0 ]]; then
        __termul_saved_prompt=$PROMPT
    fi
    if [[ -n $RPROMPT || $__termul_initialized = 0 ]]; then
        __termul_saved_rprompt=$RPROMPT
    fi
    if [ "$__termul_prompt_suppressed" = true ]; then
        # Probe in a child because readonly assignments abort a zsh function.
        if (PROMPT='' RPROMPT='') 2>/dev/null; then
            if PROMPT='' RPROMPT=''; then :; else __termul_prompt_suppressed=false; fi
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
    printf '\033]133;A;termul\007'
    __termul_frame "$json"
    if [ "$__termul_prompt_suppressed" = false ]; then
        if [[ ${(t)PROMPT} != *readonly* ]]; then PROMPT=$__termul_saved_prompt; fi
        if [[ ${(t)RPROMPT} != *readonly* ]]; then RPROMPT=$__termul_saved_rprompt; fi
    fi
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

# Reject only the internal entry point; keep the user's history policy.
__termul_history() {
    case "$1" in __termul_complete*) return 1 ;; esac
    return 0
}

# This widget runs in a real ZLE compsys context, capturing filtered compadd matches.
__termul_capture() {
    local old_compadd=${functions[compadd]-} had_compadd=${+functions[compadd]}
    compadd() {
        local -a captured __termul_args
        local -A __termul_affixes
        local __termul_flags __termul_flag __termul_value __termul_match
        local __termul_ordering __termul_order_fields __termul_valid_order __termul_have_order=0
        local __termul_prefix=$IPREFIX __termul_suffix=$ISUFFIX
        local result
        __termul_args=("$@")
        # Mirror bin_compadd's per-character walk, including both forms of '-'.
        while (( $# )) && [[ $1 = -* ]]; do
            __termul_flags=${1#-}
            shift
            [[ -n $__termul_flags ]] || break
            while [[ -n $__termul_flags ]]; do
                __termul_flag=${__termul_flags[1]}
                __termul_flags=${__termul_flags[2,-1]}
                case $__termul_flag in
                    -) break 2 ;;
                    A|O|D)
                        # Compsys also calls compadd to filter arrays, not insert words.
                        builtin compadd "${__termul_args[@]}"
                        return $?
                        ;;
                    U) __termul_prefix= __termul_suffix= ;;
                    [oPSpsiIWdJVXxrREMF])
                        # Arguments occupy the remaining group or the next word.
                        __termul_value=$__termul_flags
                        if [[ -z $__termul_value ]]; then
                            (( $# )) || break 2
                            __termul_value=$1
                        fi
                        __termul_valid_order=1
                        if [[ $__termul_flag = o ]]; then
                            # zsh validates the stored FIRST -o argument even at
                            # later occurrences; invalid values are stored too.
                            if (( ! __termul_have_order )); then
                                __termul_ordering=$__termul_value
                                __termul_have_order=1
                            fi
                            __termul_order_fields=$__termul_ordering
                            while true; do
                                case ${__termul_order_fields%%,*} in
                                    no|nos|noso|nosor|nosort|mat|matc|match|num|nume|numer|numeri|numeric|rev|reve|rever|revers|reverse) ;;
                                    *) __termul_valid_order=0; break ;;
                                esac
                                [[ $__termul_order_fields = *,* ]] || break
                                __termul_order_fields=${__termul_order_fields#*,}
                            done
                        elif (( ! ${+__termul_affixes[$__termul_flag]} )); then
                            # Retain first occurrences, including empty affixes.
                            __termul_affixes[$__termul_flag]=$__termul_value
                        fi
                        if (( __termul_valid_order )); then
                            if [[ -n $__termul_flags ]]; then
                                __termul_flags=
                            else
                                shift
                            fi
                        fi
                        ;;
                    [qQCfeakn12l]) ;;
                    *) break 2 ;; # Let the builtin reject an unknown option.
                esac
            done
        done
        builtin compadd -A captured "${__termul_args[@]}"
        result=$?
        # -A omits insertion affixes: restore zsh's seven fields in their word order.
        for __termul_match in "${captured[@]}"; do
            __termul_matches+=("$__termul_prefix${__termul_affixes[i]}${__termul_affixes[P]}${__termul_affixes[p]}$__termul_match${__termul_affixes[s]}${__termul_affixes[S]}${__termul_affixes[I]}$__termul_suffix")
        done
        return $result
    }
    _main_complete >/dev/null 2>/dev/null
    # The capture widget must never let ZLE list or insert, because Troupe renders the matches itself.
    compstate[list]=''
    compstate[insert]=''
    unfunction compadd
    if ((had_compadd)); then functions[compadd]=$old_compadd; fi
}

# add-zle-hook-widget preserves any existing zle-line-init widget.
__termul_line_init() {
    [[ -n ${__termul_pending-} ]] || return 0
    local old_buffer=$BUFFER old_cursor=$CURSOR
    local __termul_saved_pwd=$PWD __termul_name
    local -A __termul_saved_options __termul_exports
    __termul_saved_options=("${(@kv)options}")
    for __termul_name in ${(k)parameters}; do
        if [[ ${parameters[$__termul_name]} = *export* ]]; then
            __termul_exports[$__termul_name]=${(P)__termul_name}
        fi
    done
    local -a __termul_matches
    BUFFER=$__termul_draft
    CURSOR=${#BUFFER}
    zle __termul_completion_widget 2>/dev/null
    # Compsys runs in the live shell; restore its external state before emitting.
    builtin cd -q -- "$__termul_saved_pwd" || return 1
    for __termul_name in ${(k)parameters}; do
        if [[ ${parameters[$__termul_name]} = *export* && ! ${+__termul_exports[$__termul_name]} = 1 ]]; then
            unset "$__termul_name"
        fi
    done
    for __termul_name in ${(k)__termul_exports}; do
        if [[ ! ${+parameters[$__termul_name]} = 1 || ${(P)__termul_name} != ${__termul_exports[$__termul_name]} || ${parameters[$__termul_name]} != *export* ]]; then
            export "$__termul_name=${__termul_exports[$__termul_name]}" || return 1
        fi
    done
    options=("${(@kv)__termul_saved_options}")
    BUFFER=$old_buffer CURSOR=$old_cursor
    __termul_budget_completion "$__termul_request_id" "$__termul_buffer_revision" "$__termul_cursor"
    __termul_run_completer printf '%s\n' "${__termul_matches[@]}"
    __termul_pending=
    __termul_emit_completion "$__termul_request_id" "$__termul_buffer_revision" "$__termul_cursor"
}

__termul_complete() {
    local saved_status=$__termul_last_status
    local request_id=$1 buffer_revision=$2 cursor=$3 draft_hex=$4 REPLY
    __termul_decode_draft "$draft_hex"
    __termul_draft=$REPLY
    __termul_request_id=$request_id
    __termul_buffer_revision=$buffer_revision
    __termul_cursor=$cursor
    __termul_pending=1
    # Completion is emitted last by the next line-init hook.
    return "$saved_status"
}

# Save bindings before installation so a partial bootstrap can roll back.
__termul_save_bindings() {
    __termul_old_0=$(bindkey -M emacs $'\e[99;1~') || return 1
    __termul_old_1=$(bindkey -M viins $'\e[99;1~') || return 1
    __termul_old_2=$(bindkey -M vicmd $'\e[99;1~') || return 1
    __termul_old_3=$(bindkey -M emacs $'\e[99;2~') || return 1
    __termul_old_4=$(bindkey -M viins $'\e[99;2~') || return 1
    __termul_old_5=$(bindkey -M vicmd $'\e[99;2~') || return 1
    __termul_old_paste_0=$(bindkey -M emacs $'\e[200~') || return 1
    __termul_old_paste_1=$(bindkey -M viins $'\e[200~') || return 1
    __termul_old_paste_2=$(bindkey -M vicmd $'\e[200~') || return 1
    if (( ${+zle_bracketed_paste} )); then
        typeset -ga __termul_old_zle_bracketed_paste=("${zle_bracketed_paste[@]}")
        __termul_had_zle_bracketed_paste=1
    else
        __termul_had_zle_bracketed_paste=0
    fi
    __termul_paste_saved=1
}

__termul_restore_map() {
    [[ -z $2 ]] || eval "bindkey -M $1 $2"
}

__termul_restore_bindings() {
    local __termul_old_0=${__termul_old_0-} __termul_old_1=${__termul_old_1-}
    local __termul_old_2=${__termul_old_2-} __termul_old_3=${__termul_old_3-}
    local __termul_old_4=${__termul_old_4-} __termul_old_5=${__termul_old_5-}
    local map binding
    for map binding in emacs "$__termul_old_0" viins "$__termul_old_1" vicmd "$__termul_old_2" \
        emacs "$__termul_old_3" viins "$__termul_old_4" vicmd "$__termul_old_5"; do
        __termul_restore_map "$map" "$binding"
    done
    if [[ ${__termul_restore_widget_installed-} = 1 ]]; then
        zle -D __termul_restore_prompt
    fi
    if [[ ${__termul_clear_widget_installed-} = 1 ]]; then
        zle -D __termul_clear_line
    fi
    if [[ ${__termul_paste_saved-} = 1 ]]; then
        local __termul_old_paste_0=${__termul_old_paste_0-} __termul_old_paste_1=${__termul_old_paste_1-}
        local __termul_old_paste_2=${__termul_old_paste_2-}
        for map binding in emacs "$__termul_old_paste_0" viins "$__termul_old_paste_1" vicmd "$__termul_old_paste_2"; do
            __termul_restore_map "$map" "$binding"
        done
        if (( ${__termul_had_zle_bracketed_paste-} )); then
            typeset -ga zle_bracketed_paste=("${__termul_old_zle_bracketed_paste[@]}")
        else
            unset zle_bracketed_paste
        fi
    fi
}

# Empty the line and leave insert mode in emacs, viins, and vicmd.
__termul_clear_line() {
    zle kill-buffer
    if [[ $KEYMAP == vicmd ]]; then
        zle -K viins
    fi
}

__termul_bind_clear_line() {
    zle -N __termul_clear_line || return 1
    __termul_clear_widget_installed=1
    bindkey -M emacs $'\e[99;1~' __termul_clear_line || return 1
    bindkey -M viins $'\e[99;1~' __termul_clear_line || return 1
    bindkey -M vicmd $'\e[99;1~' __termul_clear_line || return 1
}

__termul_bind_restore_prompt() {
    zle -N __termul_restore_prompt || return 1
    __termul_restore_widget_installed=1
    bindkey -M emacs $'\e[99;2~' __termul_restore_prompt || return 1
    bindkey -M viins $'\e[99;2~' __termul_restore_prompt || return 1
    bindkey -M vicmd $'\e[99;2~' __termul_restore_prompt || return 1
}

__termul_bootstrap() {
    [ -n "$__termul_session_id" ] && [ -n "$__termul_nonce" ] || return 1
    [[ -o interactive ]] || return 1
    (unset PROMPT RPROMPT) 2>/dev/null || return 1
    builtin printf -v __termul_probe '%s' '' || return 1
    unset __termul_probe
    __termul_save_bindings || return 1
    __termul_bind_clear_line || return 1
    __termul_bind_restore_prompt || return 1
    autoload -Uz add-zsh-hook || return 1
    add-zsh-hook preexec __termul_preexec || return 1
    add-zsh-hook precmd __termul_prompt || {
        add-zsh-hook -d preexec __termul_preexec
        return 1
    }
    autoload -Uz compinit add-zle-hook-widget || return 1
    if (( ! $+functions[_main_complete] )); then compinit -D -i >/dev/null 2>&1 || return 1; fi
    zle -C __termul_completion_widget complete-word __termul_capture || return 1
    add-zle-hook-widget line-init __termul_line_init || return 1
    add-zsh-hook zshaddhistory __termul_history || return 1
    # Enable bracketed paste where zsh has the widget. The host wraps a submit
    # only after it sees CSI ?2004h; without that mode a multiline draft runs
    # line by line (same limitation as Warp).
    if zle -la bracketed-paste >/dev/null 2>&1; then
        if (( ! ${+zle_bracketed_paste} )); then
            typeset -ga zle_bracketed_paste=( $'\e[?2004h' $'\e[?2004l' )
        fi
        bindkey -M emacs $'\e[200~' bracketed-paste 2>/dev/null
        bindkey -M viins $'\e[200~' bracketed-paste 2>/dev/null
        bindkey -M vicmd $'\e[200~' bracketed-paste 2>/dev/null
    fi
    __termul_prompt_suppressed=true
}

# Bootstrap failure: keep the current shell.
__termul_bootstrap || {
    add-zsh-hook -d zshaddhistory __termul_history 2>/dev/null
    add-zsh-hook -d preexec __termul_preexec 2>/dev/null
    add-zsh-hook -d precmd __termul_prompt 2>/dev/null
    add-zle-hook-widget -d line-init __termul_line_init 2>/dev/null
    zle -D __termul_completion_widget 2>/dev/null
    __termul_restore_bindings 2>/dev/null
    unset __termul_old_0 __termul_old_1 __termul_old_2
    unset __termul_old_3 __termul_old_4 __termul_old_5 __termul_restore_widget_installed
    unset __termul_old_paste_0 __termul_old_paste_1 __termul_old_paste_2
    unset __termul_old_zle_bracketed_paste __termul_had_zle_bracketed_paste __termul_paste_saved
    unset __termul_clear_widget_installed
    unset __termul_session_id __termul_nonce __termul_user_zdotdir
    unset __termul_saved_prompt __termul_saved_rprompt
    unset __termul_user_command __termul_last_status
    unset __termul_prompt_generation __termul_initialized __termul_generator __termul_prompt_suppressed
    unfunction __termul_{complete,decode_draft,history,capture,line_init,prompt,budget_completion,run_completer,completion_output,emit_completion,restore_prompt,clear_line,preexec,frame,json_escape,bootstrap,save_bindings,restore_bindings,restore_map,bind_clear_line,bind_restore_prompt}
    return 0
}
unset __termul_old_0 __termul_old_1 __termul_old_2
unset __termul_old_3 __termul_old_4 __termul_old_5 __termul_restore_widget_installed
unset __termul_old_paste_0 __termul_old_paste_1 __termul_old_paste_2
unset __termul_old_zle_bracketed_paste __termul_had_zle_bracketed_paste __termul_paste_saved
unset __termul_clear_widget_installed
