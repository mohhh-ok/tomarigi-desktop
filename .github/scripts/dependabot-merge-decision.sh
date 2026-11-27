#!/usr/bin/env bash
# dependabot の PR を自動マージしてよいかを、PR 内の dependabot のコミットの message から判定する。
#
# 入力（stdin）: dependabot のコミットの message。複数あるときは ASCII の RS（0x1e）で区切る。
#   例: gh api "repos/$REPO/pulls/$PR/commits" --paginate \
#         --jq '.[] | select(.author.login == "dependabot[bot]") | .commit.message + "\u001e"'
# 出力（stdout）: 依存ごとの判定と、最後に `decision: merge` か `decision: skip`
# 終了コード: 0 = マージする / 1 = マージしない
#
# 判定:
# - message の metadata（updated-dependencies）に並ぶ依存ごとに、update-type があればそれを使う。
#   無いとき（間接依存のセキュリティ更新など）は、本文の版の差（`Updates `x` from A to B`、
#   `Bumps ... from A to B.`、件名の `from A to B`）から semver の major/minor/patch を計算する。
# - すべての依存が minor か patch のときだけマージする。major・版の下げ・版が読めない依存が
#   1 つでもあるか、dependabot のコミットが無いときはマージしない。
#
# 正本: ~/Dev/agent-config/skills/dependabot-auto-merge/scripts/dependabot-merge-decision.sh
# （テスト: 同じディレクトリの dependabot-merge-decision.test.sh）
set -euo pipefail

LC_ALL=C "${AWK:-awk}" '
BEGIN { RS = "\036"; records = 0; bad = 0; ok = 0 }

function trim(s) { sub(/^[ \t\r]+/, "", s); sub(/[ \t\r]+$/, "", s); return s }
function unquote(s) { s = trim(s); if (s ~ /^".*"$/ || s ~ /^\047.*\047$/) s = substr(s, 2, length(s) - 2); return s }

# 版の文字列から数字の部分（1.2.3）を取り出す。読めなければ空。
function numeric(v) {
  v = trim(v)
  sub(/\.$/, "", v)
  sub(/^[v^~>=< ]+/, "", v)
  if (v !~ /^[0-9]+(\.[0-9]+)*/) return ""
  match(v, /^[0-9]+(\.[0-9]+)*/)
  return substr(v, RSTART, RLENGTH)
}

# 2 つの版から update-type を計算する。判定できなければ空、下げなら "downgrade"。
function calc(from, to,    a, b, na, nb, i, x, y) {
  from = numeric(from); to = numeric(to)
  if (from == "" || to == "" || from == to) return ""
  na = split(from, a, "."); nb = split(to, b, ".")
  for (i = 1; i <= (na > nb ? na : nb); i++) {
    x = (i <= na) ? a[i] + 0 : 0; y = (i <= nb) ? b[i] + 0 : 0
    if (x != y) { if (y < x) return "downgrade"; break }
  }
  if (a[1] + 0 != b[1] + 0) return "version-update:semver-major"
  if (na < 2 || nb < 2 || a[2] + 0 != b[2] + 0) return "version-update:semver-minor"
  return "version-update:semver-patch"
}

# 行の中の「from A to B」を取り出し、FROM と TO に入れる。見つからなければ 0。
function fromto(line,    s, p) {
  p = index(line, " from ")
  if (p == 0) return 0
  s = substr(line, p + 6)
  p = index(s, " to ")
  if (p == 0) return 0
  # 「~> 1.0」のように演算子と版の間に空白がある書き方も読む
  FROM = substr(s, 1, p - 1); sub(/^[~^>=<]+ /, "", FROM); sub(/ .*/, "", FROM)
  TO = substr(s, p + 4); sub(/^[~^>=<]+ /, "", TO); sub(/ .*/, "", TO)
  return 1
}

function decide_record(rec,    n, lines, i, line, inyaml, ndeps, name, utype, single_from, single_to, has_single, q, key, k, t, pf, pt, nm) {
  n = split(rec, lines, "\n")
  inyaml = 0; ndeps = 0; has_single = 0
  delete name; delete utype; delete qf; delete qt; delete qn; delete qi
  for (i = 1; i <= n; i++) {
    line = lines[i]; sub(/\r$/, "", line)
    if (line == "---") { inyaml = 1; continue }
    if (inyaml && line == "...") { inyaml = 0; continue }
    if (inyaml) {
      if (line ~ /^- dependency-name:/) { ndeps++; nm = line; sub(/^- dependency-name:/, "", nm); name[ndeps] = unquote(nm); utype[ndeps] = "" }
      else if (ndeps > 0 && line ~ /^ +update-type:/) { t = line; sub(/^ +update-type:/, "", t); utype[ndeps] = unquote(t) }
      continue
    }
    # グループの PR: Updates `name` from A to B（同じ名前が複数回出ることがあるので順に積む）
    if (line ~ /^Updates `[^`]+` from [^ ]+ to [^ ]+$/) {
      nm = line; sub(/^Updates `/, "", nm); sub(/`.*/, "", nm)
      if (fromto(line)) { k = ++qn[nm]; qf[nm, k] = FROM; qt[nm, k] = TO }
      continue
    }
    # 単体の PR: 本文の Bumps ... from A to B. か、件名の from A to B
    if (!has_single && (line ~ /^Bumps .* from .* to / || i == 1)) {
      if (fromto(line)) { has_single = 1; single_from = FROM; single_to = TO }
    }
  }
  records++
  if (ndeps == 0) { print "依存の metadata（updated-dependencies）が読めない"; bad++; return }
  for (i = 1; i <= ndeps; i++) {
    t = utype[i]; pf = ""; pt = ""
    nm = name[i]
    if (qn[nm] > 0) { k = ++qi[nm]; if (k <= qn[nm]) { pf = qf[nm, k]; pt = qt[nm, k] } }
    else if (ndeps == 1 && has_single) { pf = single_from; pt = single_to }
    if (t == "") t = calc(pf, pt)
    printf "%s %s -> %s: %s\n", nm, (pf == "" ? "?" : pf), (pt == "" ? "?" : pt), (t == "" ? "判定できない" : t)
    if (t == "version-update:semver-minor" || t == "version-update:semver-patch") ok++
    else bad++
  }
}

{
  rec = $0
  sub(/^\n+/, "", rec)
  if (rec ~ /^[ \t\r\n]*$/) next
  decide_record(rec)
}

END {
  if (records == 0) { print "dependabot のコミットが無い"; print "decision: skip"; exit 1 }
  if (bad > 0 || ok == 0) { print "decision: skip（major・版の下げ・判定できない依存を含む）"; exit 1 }
  print "decision: merge"
  exit 0
}
'
