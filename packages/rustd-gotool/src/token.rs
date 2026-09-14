// Token numbers match Go 1.24.13 `go/token` iota (including unused sentinel slots).

pub const ILLEGAL: i32 = 0;
pub const EOF: i32 = 1;
pub const COMMENT: i32 = 2;
pub const IDENT: i32 = 4;
pub const INT: i32 = 5;
pub const FLOAT: i32 = 6;
pub const IMAG: i32 = 7;
pub const CHAR: i32 = 8;
pub const STRING: i32 = 9;
pub const ADD: i32 = 12;
pub const SUB: i32 = 13;
pub const MUL: i32 = 14;
pub const QUO: i32 = 15;
pub const REM: i32 = 16;
pub const AND: i32 = 17;
pub const OR: i32 = 18;
pub const XOR: i32 = 19;
pub const SHL: i32 = 20;
pub const SHR: i32 = 21;
pub const AND_NOT: i32 = 22;
pub const ADD_ASSIGN: i32 = 23;
pub const SUB_ASSIGN: i32 = 24;
pub const MUL_ASSIGN: i32 = 25;
pub const QUO_ASSIGN: i32 = 26;
pub const REM_ASSIGN: i32 = 27;
pub const AND_ASSIGN: i32 = 28;
pub const OR_ASSIGN: i32 = 29;
pub const XOR_ASSIGN: i32 = 30;
pub const SHL_ASSIGN: i32 = 31;
pub const SHR_ASSIGN: i32 = 32;
pub const AND_NOT_ASSIGN: i32 = 33;
pub const LAND: i32 = 34;
pub const LOR: i32 = 35;
pub const ARROW: i32 = 36;
pub const INC: i32 = 37;
pub const DEC: i32 = 38;
pub const EQL: i32 = 39;
pub const LSS: i32 = 40;
pub const GTR: i32 = 41;
pub const ASSIGN: i32 = 42;
pub const NOT: i32 = 43;
pub const NEQ: i32 = 44;
pub const LEQ: i32 = 45;
pub const GEQ: i32 = 46;
pub const DEFINE: i32 = 47;
pub const ELLIPSIS: i32 = 48;
pub const LPAREN: i32 = 49;
pub const LBRACK: i32 = 50;
pub const LBRACE: i32 = 51;
pub const COMMA: i32 = 52;
pub const PERIOD: i32 = 53;
pub const RPAREN: i32 = 54;
pub const RBRACK: i32 = 55;
pub const RBRACE: i32 = 56;
pub const SEMICOLON: i32 = 57;
pub const COLON: i32 = 58;
pub const BREAK: i32 = 61;
pub const CASE: i32 = 62;
pub const CHAN: i32 = 63;
pub const CONST: i32 = 64;
pub const CONTINUE: i32 = 65;
pub const DEFAULT: i32 = 66;
pub const DEFER: i32 = 67;
pub const ELSE: i32 = 68;
pub const FALLTHROUGH: i32 = 69;
pub const FOR: i32 = 70;
pub const FUNC: i32 = 71;
pub const GO: i32 = 72;
pub const GOTO: i32 = 73;
pub const IF: i32 = 74;
pub const IMPORT: i32 = 75;
pub const INTERFACE: i32 = 76;
pub const MAP: i32 = 77;
pub const PACKAGE: i32 = 78;
pub const RANGE: i32 = 79;
pub const RETURN: i32 = 80;
pub const SELECT: i32 = 81;
pub const STRUCT: i32 = 82;
pub const SWITCH: i32 = 83;
pub const TYPE: i32 = 84;
pub const VAR: i32 = 85;
pub const TILDE: i32 = 88;

pub const KEYWORD_BEG: i32 = 60;
pub const KEYWORD_END: i32 = 86;

pub fn lookup(ident: &str) -> i32 {
    match ident {
        "break" => BREAK,
        "case" => CASE,
        "chan" => CHAN,
        "const" => CONST,
        "continue" => CONTINUE,
        "default" => DEFAULT,
        "defer" => DEFER,
        "else" => ELSE,
        "fallthrough" => FALLTHROUGH,
        "for" => FOR,
        "func" => FUNC,
        "go" => GO,
        "goto" => GOTO,
        "if" => IF,
        "import" => IMPORT,
        "interface" => INTERFACE,
        "map" => MAP,
        "package" => PACKAGE,
        "range" => RANGE,
        "return" => RETURN,
        "select" => SELECT,
        "struct" => STRUCT,
        "switch" => SWITCH,
        "type" => TYPE,
        "var" => VAR,
        _ => IDENT,
    }
}

pub fn is_keyword_tok(tok: i32) -> bool {
    KEYWORD_BEG < tok && tok < KEYWORD_END
}

pub fn token_string(tok: i32) -> String {
    match tok {
        ILLEGAL => "ILLEGAL".into(),
        EOF => "EOF".into(),
        COMMENT => "COMMENT".into(),
        IDENT => "IDENT".into(),
        INT => "INT".into(),
        FLOAT => "FLOAT".into(),
        IMAG => "IMAG".into(),
        CHAR => "CHAR".into(),
        STRING => "STRING".into(),
        ADD => "+".into(),
        SUB => "-".into(),
        MUL => "*".into(),
        QUO => "/".into(),
        REM => "%".into(),
        AND => "&".into(),
        OR => "|".into(),
        XOR => "^".into(),
        SHL => "<<".into(),
        SHR => ">>".into(),
        AND_NOT => "&^".into(),
        ADD_ASSIGN => "+=".into(),
        SUB_ASSIGN => "-=".into(),
        MUL_ASSIGN => "*=".into(),
        QUO_ASSIGN => "/=".into(),
        REM_ASSIGN => "%=".into(),
        AND_ASSIGN => "&=".into(),
        OR_ASSIGN => "|=".into(),
        XOR_ASSIGN => "^=".into(),
        SHL_ASSIGN => "<<=".into(),
        SHR_ASSIGN => ">>=".into(),
        AND_NOT_ASSIGN => "&^=".into(),
        LAND => "&&".into(),
        LOR => "||".into(),
        ARROW => "<-".into(),
        INC => "++".into(),
        DEC => "--".into(),
        EQL => "==".into(),
        LSS => "<".into(),
        GTR => ">".into(),
        ASSIGN => "=".into(),
        NOT => "!".into(),
        NEQ => "!=".into(),
        LEQ => "<=".into(),
        GEQ => ">=".into(),
        DEFINE => ":=".into(),
        ELLIPSIS => "...".into(),
        LPAREN => "(".into(),
        LBRACK => "[".into(),
        LBRACE => "{".into(),
        COMMA => ",".into(),
        PERIOD => ".".into(),
        RPAREN => ")".into(),
        RBRACK => "]".into(),
        RBRACE => "}".into(),
        SEMICOLON => ";".into(),
        COLON => ":".into(),
        BREAK => "break".into(),
        CASE => "case".into(),
        CHAN => "chan".into(),
        CONST => "const".into(),
        CONTINUE => "continue".into(),
        DEFAULT => "default".into(),
        DEFER => "defer".into(),
        ELSE => "else".into(),
        FALLTHROUGH => "fallthrough".into(),
        FOR => "for".into(),
        FUNC => "func".into(),
        GO => "go".into(),
        GOTO => "goto".into(),
        IF => "if".into(),
        IMPORT => "import".into(),
        INTERFACE => "interface".into(),
        MAP => "map".into(),
        PACKAGE => "package".into(),
        RANGE => "range".into(),
        RETURN => "return".into(),
        SELECT => "select".into(),
        STRUCT => "struct".into(),
        SWITCH => "switch".into(),
        TYPE => "type".into(),
        VAR => "var".into(),
        TILDE => "~".into(),
        other => format!("token({other})"),
    }
}

pub const TOKEN_ENTRIES: &[(&str, i32)] = &[
    ("ILLEGAL", ILLEGAL),
    ("EOF", EOF),
    ("COMMENT", COMMENT),
    ("IDENT", IDENT),
    ("INT", INT),
    ("FLOAT", FLOAT),
    ("IMAG", IMAG),
    ("CHAR", CHAR),
    ("STRING", STRING),
    ("ADD", ADD),
    ("SUB", SUB),
    ("MUL", MUL),
    ("QUO", QUO),
    ("REM", REM),
    ("AND", AND),
    ("OR", OR),
    ("XOR", XOR),
    ("SHL", SHL),
    ("SHR", SHR),
    ("AND_NOT", AND_NOT),
    ("ADD_ASSIGN", ADD_ASSIGN),
    ("SUB_ASSIGN", SUB_ASSIGN),
    ("MUL_ASSIGN", MUL_ASSIGN),
    ("QUO_ASSIGN", QUO_ASSIGN),
    ("REM_ASSIGN", REM_ASSIGN),
    ("AND_ASSIGN", AND_ASSIGN),
    ("OR_ASSIGN", OR_ASSIGN),
    ("XOR_ASSIGN", XOR_ASSIGN),
    ("SHL_ASSIGN", SHL_ASSIGN),
    ("SHR_ASSIGN", SHR_ASSIGN),
    ("AND_NOT_ASSIGN", AND_NOT_ASSIGN),
    ("LAND", LAND),
    ("LOR", LOR),
    ("ARROW", ARROW),
    ("INC", INC),
    ("DEC", DEC),
    ("EQL", EQL),
    ("LSS", LSS),
    ("GTR", GTR),
    ("ASSIGN", ASSIGN),
    ("NOT", NOT),
    ("NEQ", NEQ),
    ("LEQ", LEQ),
    ("GEQ", GEQ),
    ("DEFINE", DEFINE),
    ("ELLIPSIS", ELLIPSIS),
    ("LPAREN", LPAREN),
    ("LBRACK", LBRACK),
    ("LBRACE", LBRACE),
    ("COMMA", COMMA),
    ("PERIOD", PERIOD),
    ("RPAREN", RPAREN),
    ("RBRACK", RBRACK),
    ("RBRACE", RBRACE),
    ("SEMICOLON", SEMICOLON),
    ("COLON", COLON),
    ("BREAK", BREAK),
    ("CASE", CASE),
    ("CHAN", CHAN),
    ("CONST", CONST),
    ("CONTINUE", CONTINUE),
    ("DEFAULT", DEFAULT),
    ("DEFER", DEFER),
    ("ELSE", ELSE),
    ("FALLTHROUGH", FALLTHROUGH),
    ("FOR", FOR),
    ("FUNC", FUNC),
    ("GO", GO),
    ("GOTO", GOTO),
    ("IF", IF),
    ("IMPORT", IMPORT),
    ("INTERFACE", INTERFACE),
    ("MAP", MAP),
    ("PACKAGE", PACKAGE),
    ("RANGE", RANGE),
    ("RETURN", RETURN),
    ("SELECT", SELECT),
    ("STRUCT", STRUCT),
    ("SWITCH", SWITCH),
    ("TYPE", TYPE),
    ("VAR", VAR),
    ("TILDE", TILDE),
];
