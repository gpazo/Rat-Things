use egui_commonmark::{CommonMarkCache, CommonMarkViewer};
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};

#[derive(Default, Debug)]
pub(crate) struct Markdown {
    blocks: Vec<Block>,
}

#[derive(Debug)]
enum Block {
    Text(String),
    List {
        start: Option<u64>,
        items: Vec<ListItem>,
    },
}

#[derive(Debug)]
struct ListItem {
    checked: Option<bool>,
    label: String,
    blocks: Vec<Block>,
}

fn text_block(events: &[Event<'_>]) -> Block {
    let mut text = String::new();
    // Parser events are balanced; serialization cannot fail when writing a String.
    pulldown_cmark_to_cmark::cmark(events.iter(), &mut text).expect("serialize Markdown events");
    Block::Text(text)
}

fn matching_end(events: &[Event<'_>], start: usize) -> usize {
    let mut depth = 0;
    for (offset, event) in events[start..].iter().enumerate() {
        match event {
            Event::Start(_) => depth += 1,
            Event::End(_) => {
                depth -= 1;
                if depth == 0 {
                    return start + offset;
                }
            }
            _ => {}
        }
    }
    unreachable!("balanced parser events")
}

fn blocks(events: &[Event<'_>]) -> Vec<Block> {
    let mut result = Vec::new();
    let mut pending = 0;
    let mut index = 0;
    while index < events.len() {
        if let Event::Start(tag) = &events[index] {
            let end = matching_end(events, index);
            if let Tag::List(start) = tag
                && events[index..end]
                    .iter()
                    .any(|event| matches!(event, Event::TaskListMarker(_)))
            {
                if pending < index {
                    result.push(text_block(&events[pending..index]));
                }
                let mut items = Vec::new();
                let mut item_start = index + 1;
                while item_start < end {
                    let item_end = matching_end(events, item_start);
                    let mut checked = None;
                    let mut body = Vec::new();
                    let mut label = String::new();
                    let mut list_depth = 0;
                    for event in &events[item_start + 1..item_end] {
                        match event {
                            Event::TaskListMarker(value)
                                if list_depth == 0 && checked.is_none() =>
                            {
                                checked = Some(*value)
                            }
                            _ => {
                                match event {
                                    Event::Start(Tag::List(_)) => list_depth += 1,
                                    Event::End(TagEnd::List(_)) => list_depth -= 1,
                                    Event::Text(text) | Event::Code(text) if list_depth == 0 => {
                                        label.push_str(text)
                                    }
                                    Event::SoftBreak | Event::HardBreak if list_depth == 0 => {
                                        label.push(' ')
                                    }
                                    _ => {}
                                }
                                body.push(event.clone());
                            }
                        }
                    }
                    items.push(ListItem {
                        checked,
                        label,
                        blocks: blocks(&body),
                    });
                    item_start = item_end + 1;
                }
                result.push(Block::List {
                    start: *start,
                    items,
                });
                pending = end + 1;
            }
            index = end + 1;
        } else {
            index += 1;
        }
    }
    if pending < events.len() {
        result.push(text_block(&events[pending..]));
    }
    result
}

impl Markdown {
    pub(crate) fn new(source: &str) -> Self {
        let safe = safe_markdown(source);
        Self {
            blocks: blocks(&Parser::new_ext(&safe, Options::all()).collect::<Vec<_>>()),
        }
    }

    pub(crate) fn show(&self, ui: &mut egui::Ui, cache: &mut CommonMarkCache) {
        show_blocks(ui, cache, &self.blocks);
    }
}

fn show_blocks(ui: &mut egui::Ui, cache: &mut CommonMarkCache, blocks: &[Block]) {
    for block in blocks {
        match block {
            Block::Text(text) => {
                CommonMarkViewer::new()
                    .explicit_image_uri_scheme(true)
                    .show(ui, cache, text);
            }
            Block::List { start, items } => {
                for (index, item) in items.iter().enumerate() {
                    ui.horizontal_top(|ui| {
                        let height = ui.text_style_height(&egui::TextStyle::Body);
                        let (rect, response) =
                            ui.allocate_exact_size(egui::vec2(20.0, height), egui::Sense::hover());
                        if let Some(checked) = item.checked {
                            response.widget_info(|| {
                                egui::WidgetInfo::selected(
                                    egui::Role::CheckBox,
                                    false,
                                    checked,
                                    &item.label,
                                )
                            });
                            let square =
                                egui::Rect::from_center_size(rect.center(), egui::vec2(13.0, 13.0));
                            ui.painter().rect_stroke(
                                square,
                                3.0,
                                egui::Stroke::new(1.0, crate::theme::MUTED),
                                egui::StrokeKind::Inside,
                            );
                            if checked {
                                ui.painter().add(egui::Shape::line(
                                    vec![
                                        square.left_top() + egui::vec2(3.0, 6.5),
                                        square.left_top() + egui::vec2(5.5, 9.0),
                                        square.left_top() + egui::vec2(10.0, 3.5),
                                    ],
                                    egui::Stroke::new(1.5, crate::theme::TEXT),
                                ));
                            }
                        } else if let Some(start) = start {
                            ui.painter().text(
                                rect.right_center(),
                                egui::Align2::RIGHT_CENTER,
                                format!("{}.", start.saturating_add(index as u64)),
                                egui::TextStyle::Body.resolve(ui.style()),
                                crate::theme::TEXT,
                            );
                        } else {
                            ui.painter()
                                .circle_filled(rect.center(), 2.0, crate::theme::TEXT);
                        }
                        ui.vertical(|ui| {
                            ui.set_width(ui.available_width());
                            show_blocks(ui, cache, &item.blocks);
                        });
                    });
                }
            }
        }
    }
}

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
    fn task_lists_keep_states_formatting_nesting_and_ordinary_siblings() {
        let document = Markdown::new(
            "Before\n\n3. [x] **Review** `logo`\n4. Ordinary item\n5. [ ] Run locally\n   - [x] Nested task\n\nAfter\n\n```md\n- [ ] literal\n```",
        );
        let Block::List { start, items } = &document.blocks[1] else {
            panic!("task list")
        };
        assert_eq!(*start, Some(3));
        assert_eq!(
            items.iter().map(|item| item.checked).collect::<Vec<_>>(),
            [Some(true), None, Some(false)]
        );
        assert_eq!(items[0].label, "Review logo");
        let Block::Text(formatted) = &items[0].blocks[0] else {
            panic!("formatted label")
        };
        assert!(formatted.contains("**Review**"));
        assert!(formatted.contains("`logo`"));
        let Block::List { items: nested, .. } = &items[2].blocks[1] else {
            panic!("nested list")
        };
        assert_eq!(nested[0].checked, Some(true));
        assert_eq!(items[2].checked, Some(false));
        let Block::Text(tail) = document.blocks.last().unwrap() else {
            panic!("remaining prose")
        };
        assert!(tail.contains("After"));
        assert!(tail.contains("- [ ] literal"));
        assert!(matches!(
            Markdown::new("- ordinary\n- list").blocks.as_slice(),
            [Block::Text(_)]
        ));
    }

    #[test]
    fn checklists_render_read_only_aligned_and_wrap_within_the_message() {
        use egui::accesskit::{Role, Toggled};
        use egui_kittest::{
            Harness,
            kittest::{NodeT, Queryable},
        };
        let document = Markdown::new(
            "- [ ] Review the new logo\n- [x] Run locally\n- [ ] Share the demo with the team after checking that every wrapped line stays aligned with the task text.",
        );
        for width in [300.0, 720.0] {
            let mut cache = CommonMarkCache::default();
            let mut app = Harness::builder()
                .with_size(egui::vec2(width, 380.0))
                .build_ui(|ui| document.show(ui, &mut cache));
            crate::theme::apply(&app.ctx);
            app.run();
            let boxes = app.query_all_by_role(Role::CheckBox).collect::<Vec<_>>();
            assert_eq!(boxes.len(), 3);
            for checkbox in &boxes {
                assert!(checkbox.accesskit_node().is_disabled());
            }
            assert_eq!(boxes[0].accesskit_node().toggled(), Some(Toggled::False));
            assert_eq!(boxes[1].accesskit_node().toggled(), Some(Toggled::True));
            assert_eq!(boxes[0].rect().left(), boxes[2].rect().left());
            assert!(boxes[1].rect().top() >= boxes[0].rect().bottom());
            let label = app.get_by_role_and_label(Role::Label, "Share the demo with the team after checking that every wrapped line stays aligned with the task text.");
            assert!(label.rect().left() > boxes[2].rect().right());
            assert!(label.rect().right() <= width);
            if width == 300.0 {
                assert!(label.rect().height() > boxes[2].rect().height() * 2.0);
            }
            let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../test-results/native-console");
            std::fs::create_dir_all(&directory).unwrap();
            app.render()
                .unwrap()
                .save(directory.join(format!("checklist-{width}.png")))
                .unwrap();
        }
    }

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
