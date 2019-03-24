'use babel';

import { $, View } from 'atom-space-pen-views';
const Storage = require('./../helper/storage.js');

class FtpSelectView extends View {

  static content() {
    return this.div({
      class: 'ftp-remote-edit-select-view tool-panel panel-top',
      tabindex: -1
    }, () => {
        this.div({
          class: 'panels-content',
          outlet: 'content',
        });
    });
  }

  initialize() {
    const self = this;

    self.select = document.createElement('select');
    self.select.classList.add('form-control');
    self.content.append(self.select);

    self.reload();
  }


  reload() {
    const self = this;
    while (self.select.firstChild) {
      self.select.removeChild(self.select.firstChild);
    }

    if (atom.config.get('ftp-remote-edit.tree.showSelectOnTop')) {

      let option = document.createElement("option");
      option.text = 'Show all folders and servers';
      option.value = null;
      self.select.add(option);

      Storage.getFullStructuredByTree().forEach((config) => {
        let option = document.createElement("option");
        option.text = config.name;
        option.value = config.id;
        option.dataset.parents_id = config.parents_id;
        self.select.add(option);
      });

      self.removeClass('hidden');
    } else {
      self.addClass('hidden');
    }
  }

  destroy() {
    const self = this;

    self.remove();
  }
}

module.exports = FtpSelectView;
