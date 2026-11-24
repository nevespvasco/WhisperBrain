'use strict';
// One vocabulary of roles for the selectors, whichever system the tree came from. The Linux names (AT-SPI: "static",
// "list", "list item", "section", "document web"…) are the common ones; the other systems' native roles map onto them,
// so a selector file written on one system reads the trees of the others.
const MAC = {
  AXWebArea: 'document web', AXStaticText: 'static', AXList: 'list', AXRow: 'list item', AXGroup: 'section', AXHeading: 'heading',
  AXLink: 'link', AXButton: 'push button', AXImage: 'image', AXTextField: 'entry', AXTextArea: 'entry', AXCheckBox: 'check box',
  AXRadioButton: 'radio button', AXMenu: 'menu', AXMenuItem: 'menu item', AXTable: 'table', AXCell: 'table cell', AXScrollArea: 'scroll pane',
  AXSplitGroup: 'section', AXToolbar: 'tool bar', AXTabGroup: 'page tab list', AXRadioGroup: 'section', AXUnknown: 'unknown', AXLayoutArea: 'section',
};
const WIN = {
  Document: 'document web', Text: 'static', List: 'list', ListItem: 'list item', Group: 'section', Pane: 'section', Custom: 'section',
  Header: 'heading', Hyperlink: 'link', Button: 'push button', Image: 'image', Edit: 'entry', CheckBox: 'check box', RadioButton: 'radio button',
  Menu: 'menu', MenuItem: 'menu item', Table: 'table', DataItem: 'table cell', Tab: 'page tab list', TabItem: 'page tab', ToolBar: 'tool bar', Window: 'frame',
};
// macOS subroles refine a group: a list's rows are groups with the subrole AXListItem (as in Chromium's mapping)
const MAC_SUB = { AXListItem: 'list item', AXHeading: 'heading' };

// platform: 'linux' | 'darwin' | 'win32'. node: { r, a? }. -> the common role name
function role(platform, node) {
  const r = String(node.r || '');
  if (platform === 'darwin') return (node.a?.subrole && MAC_SUB[node.a.subrole]) || MAC[r] || r.replace(/^AX/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  if (platform === 'win32') return WIN[r.replace(/^ControlType\./, '')] || r.replace(/^ControlType\./, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return r;
}

module.exports = { role, MAC, WIN };
