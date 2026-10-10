use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};

pub(crate) fn safe_markdown(source: &str) -> String {
    let mut link_allowed = Vec::new();
    let events = Parser::new_ext(source, Options::all()).filter_map(|event| match event {
        Event::Start(Tag::Image { .. }) => Some(Event::Text("[Image: ".into())),
        Event::End(TagEnd::Image) => Some(Event::Text("]".into())),
        Event::Start(Tag::Link { ref dest_url, .. }) => {
            let allowed = reqwest::Url::parse(dest_url).is_ok_and(|url| {
                matches!(url.scheme(), "http" | "https") && url.host_str().is_some()
            });
            link_allowed.push(allowed);
            allowed.then_some(event)
        }
        Event::End(TagEnd::Link) => link_allowed.pop().unwrap_or(false).then_some(event),
        Event::Html(text) | Event::InlineHtml(text) => Some(Event::Text(text)),
        other => Some(other),
    });
    let mut safe = String::new();
    if pulldown_cmark_to_cmark::cmark(events, &mut safe).is_err() {
        return source.replace('[', "\\[").replace('<', "\\<");
    }
    safe
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_web_links_survive_and_images_never_load() {
        let markdown = safe_markdown(
            "**Ready** [Runbook](https://example.com/docs) [Unsafe](javascript:alert) [Local](file:///etc/passwd) ![Remote](https://example.com/image.png) ![Local image](/etc/passwd) <img src=\"file:///etc/passwd\">\n\n```sh\necho ok\n```",
        );
        let mut links = Vec::new();
        let mut code_blocks = 0;
        for event in Parser::new_ext(&markdown, Options::all()) {
            match event {
                Event::Start(Tag::Link { dest_url, .. }) => links.push(dest_url.to_string()),
                Event::Start(Tag::Image { .. }) | Event::Html(_) | Event::InlineHtml(_) => {
                    panic!("Unsafe markdown element survived")
                }
                Event::Start(Tag::CodeBlock(_)) => code_blocks += 1,
                _ => {}
            }
        }
        assert_eq!(links, ["https://example.com/docs"]);
        assert_eq!(code_blocks, 1);
        assert!(markdown.contains("Unsafe"));
        assert!(markdown.contains("Remote"));
    }
}
