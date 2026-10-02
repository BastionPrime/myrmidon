package jsonx

import (
	"strings"
	"testing"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/deny"
)

func TestParseAccepts(t *testing.T) {
	ok := []string{
		`{}`, `[]`, `"x"`, `0`, `-0`, `7`, `true`, `false`,
		` {"a":1,"b":[true,"x"],"c":{"d":"e"}} `,
		"\t\r\n{\"a\": 1}\n",
		`{"a":9007199254740992}`, `{"a":-9007199254740992}`,
		`"é😀\/"`,
		`{"a":{"b":{"c":{}}}}`, // depth 4
	}
	for _, in := range ok {
		if _, err := Parse([]byte(in)); err != nil {
			t.Errorf("Parse(%q): %s (%s)", in, err.Code, err.Detail)
		}
	}
}

func TestParseKeepsMemberOrder(t *testing.T) {
	v, err := Parse([]byte(`{"z":1,"a":2,"m":3}`))
	if err != nil {
		t.Fatal(err)
	}
	var keys []string
	for _, m := range v.Members {
		keys = append(keys, m.Key)
	}
	if strings.Join(keys, ",") != "z,a,m" {
		t.Fatalf("order: %v", keys)
	}
	if v.Get("a").N != 2 || v.Get("nope") != nil {
		t.Fatal("Get")
	}
}

func TestRedTeam_RT1_9_Parser(t *testing.T) {
	cases := []struct {
		name string
		in   string
		code string
	}{
		{"bom", "\xef\xbb\xbf{}", deny.JSONSyntax},
		{"invalid utf8", "{\"a\":\"\xff\"}", deny.JSONSyntax},
		{"empty", ``, deny.JSONSyntax},
		{"trailing value", `{} {}`, deny.JSONSyntax},
		{"trailing garbage", `{}x`, deny.JSONSyntax},
		{"unterminated", `{"a":1`, deny.JSONSyntax},
		{"comma", `{"a":1,}`, deny.JSONSyntax},
		{"single quote", `{'a':1}`, deny.JSONSyntax},
		{"leading zero", `{"a":01}`, deny.JSONSyntax},
		{"bare minus", `-`, deny.JSONSyntax},
		{"control char in string", "\"a\x01b\"", deny.JSONSyntax},
		{"bad escape", `"\q"`, deny.JSONSyntax},
		{"nul escape", `"\u0000"`, deny.JSONSyntax},
		{"lone high surrogate", `"\ud800"`, deny.JSONSyntax},
		{"lone low surrogate", `"\udc00"`, deny.JSONSyntax},
		{"short unicode escape", `"\u12"`, deny.JSONSyntax},
		{"literal typo", `tru`, deny.JSONSyntax},
		{"fraction", `{"a":1.5}`, deny.JSONType},
		{"exponent", `{"a":1e3}`, deny.JSONType},
		{"capital exponent", `{"a":1E3}`, deny.JSONType},
		{"null", `{"a":null}`, deny.JSONType},
		{"integer over 2^53", `{"a":9007199254740993}`, deny.JSONValue},
		{"negative over 2^53", `{"a":-9007199254740993}`, deny.JSONValue},
		{"huge integer", `{"a":123456789012345678901234567890}`, deny.JSONValue},
		{"depth 5 object", `{"a":{"b":{"c":{"d":{}}}}}`, deny.JSONValue},
		{"depth 5 array", `[[[[[]]]]]`, deny.JSONValue},
		{"duplicate key", `{"a":1,"a":2}`, deny.JSONDuplicateKey},
		{"duplicate key by case", `{"Image":"x","image":"y"}`, deny.JSONDuplicateKey},
		{"duplicate key after escape", `{"a":1,"a":2}`, deny.JSONDuplicateKey},
		{"nested duplicate", `{"a":{"b":1,"B":2}}`, deny.JSONDuplicateKey},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Parse([]byte(tc.in))
			if err == nil {
				t.Fatalf("Parse(%q) accepted", tc.in)
			}
			if err.Code != tc.code {
				t.Fatalf("Parse(%q): %s (%s), want %s", tc.in, err.Code, err.Detail, tc.code)
			}
		})
	}
}

func TestParseStringLimit(t *testing.T) {
	ok := `"` + strings.Repeat("a", MaxString) + `"`
	if _, err := Parse([]byte(ok)); err != nil {
		t.Fatalf("string of the maximum length: %s", err.Code)
	}
	long := `"` + strings.Repeat("a", MaxString+1) + `"`
	if _, err := Parse([]byte(long)); err == nil || err.Code != deny.JSONValue {
		t.Fatalf("string over the limit: %v", err)
	}
}

func TestErrorsCarryNoInputValue(t *testing.T) {
	_, err := Parse([]byte(`{"secret-value-marker":1,"secret-value-marker":2}`))
	if err == nil {
		t.Fatal("accepted")
	}
	if strings.Contains(err.Detail, "secret") || strings.Contains(err.Field, "secret") {
		t.Fatalf("value in the error: %+v", err)
	}
}

func TestKindString(t *testing.T) {
	for k, want := range map[Kind]string{KindObject: "object", KindArray: "array", KindString: "string", KindInt: "integer", KindBool: "boolean"} {
		if k.String() != want {
			t.Errorf("%d -> %s", k, k.String())
		}
	}
}
