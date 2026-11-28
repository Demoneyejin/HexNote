package drive

import "testing"

func TestLocalizeContentAcceptsEveryForm(t *testing.T) {
	const ws = "local-ws"
	tests := []struct{ name, in, want string }{
		{"old absolute from another PC", "![a](/images/0f3c9a1e-aaaa-bbbb-cccc-111122223333/img-x.png)", "![a](/images/local-ws/img-x.png)"},
		{"double slash", "![a](//images/0f3c9a1e-aaaa/img-x.png)", "![a](/images/local-ws/img-x.png)"},
		{"double slash capital", "![a](//Images/abc/img-x.png)", "![a](/images/local-ws/img-x.png)"},
		{"new relative top level", "![a](assets/img-x.png)", "![a](/images/local-ws/img-x.png)"},
		{"new relative dot slash", "![a](./assets/img-x.png)", "![a](/images/local-ws/img-x.png)"},
		{"new relative nested", "![a](../../assets/img-x.png \"title\")", "![a](/images/local-ws/img-x.png \"title\")"},
		{"html img", `<img src="assets/img-x.png">`, `<img src="/images/local-ws/img-x.png">`},
		{"prose mentioning assets is untouched", "Put files in assets/ please.", "Put files in assets/ please."},
		{"external link untouched", "![a](https://example.com/assets/x.png)", "![a](https://example.com/assets/x.png)"},
		{"two images", "![a](assets/1.png) ![b](/images/old/2.png)", "![a](/images/local-ws/1.png) ![b](/images/local-ws/2.png)"},
		{"external URL with /images/ untouched", "![p](https://cdn.example.com/images/products/shoe.png)", "![p](https://cdn.example.com/images/products/shoe.png)"},
		{"external URL capital Images untouched", "![p](https://x.org/Images/abc/y.png)", "![p](https://x.org/Images/abc/y.png)"},
		{"reference-style definition", "![a][1]\n\n[1]: assets/img-x.png", "![a][1]\n\n[1]: /images/local-ws/img-x.png"},
		{"prose mentioning /images/ path untouched", "Old links looked like /images/abc/x.png.", "Old links looked like /images/abc/x.png."},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := LocalizeContent(tt.in, ws); got != tt.want {
				t.Errorf("got  %q\nwant %q", got, tt.want)
			}
		})
	}
}

func TestPortableContent(t *testing.T) {
	in := "Intro\n\n![shot](/images/local-ws/img-a.png)\n\n<img src=\"/images/local-ws/img-b.png\">\n\nText about /images/ paths stays.\n"
	if got := PortableContent(in, 0); got != "Intro\n\n![shot](assets/img-a.png)\n\n<img src=\"assets/img-b.png\">\n\nText about /images/ paths stays.\n" {
		t.Errorf("depth 0: %q", got)
	}
	if got := PortableContent("![s](/images/w/x.png)", 2); got != "![s](../../assets/x.png)" {
		t.Errorf("depth 2: %q", got)
	}
	// Round trip back to local.
	for depth := 0; depth < 3; depth++ {
		p := PortableContent("![s](/images/w/x.png)", depth)
		if got := LocalizeContent(p, "w"); got != "![s](/images/w/x.png)" {
			t.Errorf("round trip at depth %d: %q -> %q", depth, p, got)
		}
	}
}
