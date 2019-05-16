'use babel';

import ConfigurationView from './views/configuration-view';
import PermissionsView from './views/permissions-view';
import TreeView from './views/tree-view';
import ProtocolView from './views/protocol-view';
import FinderView from './views/finder-view';

import ChangePassDialog from './dialogs/change-pass-dialog.js';
import PromptPassDialog from './dialogs/prompt-pass-dialog.js';
import AddDialog from './dialogs/add-dialog.js';
import RenameDialog from './dialogs/rename-dialog.js';
import FindDialog from './dialogs/find-dialog.js';
import DuplicateDialog from './dialogs/duplicate-dialog';

import { CompositeDisposable, Disposable, TextEditor } from 'atom';
import { decrypt, encrypt, checkPasswordExists, checkPassword, setPassword, changePassword, isInWhiteList, isInBlackList, addToWhiteList, addToBlackList } from './helper/secure.js';
import { basename, dirname, trailingslashit, untrailingslashit, leadingslashit, unleadingslashit, normalize } from './helper/format.js';
import { logDebug, showMessage, getFullExtension, createLocalPath, deleteLocalPath, moveLocalPath, getTextEditor, permissionsToRights } from './helper/helper.js';

const config = require('./config/config-schema.json');
const server_config = require('./config/server-schema.json');

const atom = global.atom;
const Electron = require('electron');
const Path = require('path');
const FileSystem = require('fs-plus');
const getIconServices = require('./helper/icon.js');
const Queue = require('./helper/queue.js');
const Storage = require('./helper/storage.js');

require('events').EventEmitter.defaultMaxListeners = 0;

class FtpRemoteEdit {

  constructor() {
    const self = this;

    self.info = [];
    self.config = config;
    self.subscriptions = null;

    self.treeView = null;
    self.protocolView = null;
    self.configurationView = null;
    self.finderView = null;
  }

  activate() {
    const self = this;

    self.treeView = new TreeView();
    self.protocolView = new ProtocolView();

    // Events subscribed to in atom's system can be easily cleaned up with a CompositeDisposable
    self.subscriptions = new CompositeDisposable();

    // Register command that toggles this view
    self.subscriptions.add(atom.commands.add('atom-workspace', {
      'ftp-remote-edit:toggle': () => self.toggle(),
      'ftp-remote-edit:toggle-focus': () => self.toggleFocus(),
      'ftp-remote-edit:show': () => self.show(),
      'ftp-remote-edit:hide': () => self.hide(),
      'ftp-remote-edit:unfocus': () => self.treeView.unfocus(),
      'ftp-remote-edit:edit-servers': () => self.configuration(),
      'ftp-remote-edit:change-password': () => self.changePassword(),
      'ftp-remote-edit:open-file': () => self.open(),
      'ftp-remote-edit:open-file-pending': () => self.open(true),
      'ftp-remote-edit:new-file': () => self.create('file'),
      'ftp-remote-edit:new-directory': () => self.create('directory'),
      'ftp-remote-edit:duplicate': () => self.duplicate(),
      'ftp-remote-edit:delete': () => self.delete(),
      'ftp-remote-edit:rename': () => self.rename(),
      'ftp-remote-edit:copy': () => self.copy(),
      'ftp-remote-edit:cut': () => self.cut(),
      'ftp-remote-edit:paste': () => self.paste(),
      'ftp-remote-edit:chmod': () => self.chmod(),
      'ftp-remote-edit:upload-file': () => self.upload('file'),
      'ftp-remote-edit:upload-directory': () => self.upload('directory'),
      'ftp-remote-edit:download': () => self.download(),
      'ftp-remote-edit:reload': () => self.reload(),
      'ftp-remote-edit:find-remote-path': () => self.findRemotePath(),
      'ftp-remote-edit:copy-remote-path': () => self.copyRemotePath(),
      'ftp-remote-edit:finder': () => self.remotePathFinder(),
      'ftp-remote-edit:finder-reindex-cache': () => self.remotePathFinder(true),
      'ftp-remote-edit:add-temp-server': () => self.addTempServer(),
      'ftp-remote-edit:remove-temp-server': () => self.removeTempServer(),
    }));

    // Events
    atom.config.onDidChange('ftp-remote-edit.config', () => {
      if (Storage.getPassword()) {
        Storage.load(true);
        self.treeView.reload();
      }
    });

    // Drag & Drop
    self.treeView.on('drop', (e) => {
      self.drop(e);
    });

    // Auto Reveal Active File
    atom.workspace.getCenter().onDidStopChangingActivePaneItem((item) => {
      self.autoRevealActiveFile();
    });

    // workaround to activate core.allowPendingPaneItems if ftp-remote-edit.tree.allowPendingPaneItems is activated
    atom.config.onDidChange('ftp-remote-edit.tree.allowPendingPaneItems', ({ newValue, oldValue }) => {
      if (newValue == true && !atom.config.get('core.allowPendingPaneItems')) {
        atom.config.set('core.allowPendingPaneItems', true)
      }
    });
    if (atom.config.get('ftp-remote-edit.tree.allowPendingPaneItems')) {
      atom.config.set('core.allowPendingPaneItems', true)
    }

    // Toggle on startup
    atom.packages.onDidActivatePackage((activatePackage) => {
      if (activatePackage.name == 'ftp-remote-edit') {
        if (atom.config.get('ftp-remote-edit.tree.toggleOnStartup')) {
          self.toggle();
        }
      }
    });
  }

  deactivate() {
    const self = this;

    if (self.subscriptions) {
      self.subscriptions.dispose();
      self.subscriptions = null;
    }

    if (self.treeView) {
      self.treeView.destroy();
    }

    if (self.protocolView) {
      self.protocolView.destroy();
    }

    if (self.configurationView) {
      self.configurationView.destroy();
    }

    if (self.finderView) {
      finderView.destroy();
    }
  }

  serialize() {
    return {};
  }

  handleURI(parsedUri) {
    const self = this;

    let regex = /(\/)?([a-z0-9_\-]{1,5}:\/\/)(([^:]{1,})((:(.{1,}))?[\@\x40]))?([a-z0-9_\-.]+)(:([0-9]*))?(.*)/gi;
    let is_matched = parsedUri.path.match(regex);

    if (is_matched) {

      if (!self.treeView.isVisible()) {
        self.toggle();
      }

      let matched = regex.exec(parsedUri.path);

      let protocol = matched[2];
      let username = (matched[4] !== undefined) ? decodeURIComponent(matched[4]) : '';
      let password = (matched[7] !== undefined) ? decodeURIComponent(matched[7]) : '';
      let host = (matched[8] !== undefined) ? matched[8] : '';
      let port = (matched[10] !== undefined) ? matched[10] : '';
      let path = (matched[11] !== undefined) ? decodeURIComponent(matched[11]) : "/";

      let newconfig = JSON.parse(JSON.stringify(server_config));
      newconfig.name = (username) ? protocol + username + '@' + host : protocol + host;
      newconfig.host = host;
      newconfig.port = (port) ? port : ((protocol == 'sftp://') ? '22' : '21');
      newconfig.user = username;
      newconfig.password = password;
      newconfig.sftp = (protocol == 'sftp://');
      newconfig.remote = path;
      newconfig.temp = true;

      logDebug("Adding new server by uri handler", newconfig);

      self.treeView.addServer(newconfig);
    }
  }

  openRemoteFile() {
    const self = this;

    return (file) => {
      const selected = self.treeView.list.find('.selected');

      if (selected.length === 0) return;

      let root = selected.view().getRoot();
      let localPath = normalize(root.getLocalPath());
      localPath = normalize(Path.join(localPath.slice(0, localPath.lastIndexOf(root.getPath())), file).replace(/\/+/g, Path.sep), Path.sep);

      try {
        let file = self.treeView.getElementByLocalPath(localPath, root, 'file');
        self.openFile(file);

        return true;
      } catch (ex) {
        logDebug(ex)

        return false;
      }
    }
  }

  getCurrentServerName() {
    const self = this;

    return () => {
      return new Promise((resolve, reject) => {
        const selected = self.treeView.list.find('.selected');
        if (selected.length === 0) reject('noservers');

        let root = selected.view().getRoot();
        resolve(root.name);
      })
    }
  }

  getCurrentServerConfig() {
    const self = this;

    return (reasonForRequest) => {
      return new Promise((resolve, reject) => {
        if (!reasonForRequest) {
          reject('noreasongiven');
          return;
        }

        const selected = self.treeView.list.find('.selected');
        if (selected.length === 0) {
          reject('noservers');
          return;
        }

        if (!Storage.hasPassword()) {
          reject('nopassword');
          return;
        }

        let root = selected.view().getRoot();
        let buttondismiss = false;

        if (isInBlackList(Storage.getPassword(), reasonForRequest)) {
          reject('userdeclined');
          return;
        }
        if (isInWhiteList(Storage.getPassword(), reasonForRequest)) {
          resolve(root.config);
          return;
        }

        let caution = 'Decline this message if you did not initiate a request to share your server configuration with a pacakge!'
        let notif = atom.notifications.addWarning('Server Configuration Requested', {
          detail: reasonForRequest + '\n-------------------------------\n' + caution,
          dismissable: true,
          buttons: [{
            text: 'Always',
            onDidClick: () => {
              buttondismiss = true;
              notif.dismiss();
              addToWhiteList(Storage.getPassword(), reasonForRequest);
              resolve(root.config);
            }
          },
          {
            text: 'Accept',
            onDidClick: () => {
              buttondismiss = true;
              notif.dismiss();
              resolve(root.config);
            }
          },
          {
            text: 'Decline',
            onDidClick: () => {
              buttondismiss = true;
              notif.dismiss();
              reject('userdeclined');
            }
          },
          {
            text: 'Never',
            onDidClick: () => {
              buttondismiss = true;
              notif.dismiss();
              addToBlackList(Storage.getPassword(), reasonForRequest);
              reject('userdeclined');
            }
          },
          ]
        });

        let disposable = notif.onDidDismiss(() => {
          if (!buttondismiss) reject('userdeclined');
          disposable.dispose();
        })
      })
    }
  }

  consumeElementIcons(service) {
    getIconServices().setElementIcons(service);

    return new Disposable(() => {
      getIconServices().resetElementIcons();
    })
  }

  promtPassword() {
    const self = this;
    const dialog = new PromptPassDialog();

    let promise = new Promise((resolve, reject) => {
      dialog.on('dialog-done', (e, password) => {
        if (checkPassword(password)) {
          Storage.setPassword(password);
          dialog.close();

          resolve(true);
        } else {
          dialog.showError('Wrong password, try again!');
        }
      });

      dialog.attach();
    });

    return promise;
  }

  changePassword(mode) {
    const self = this;

    const options = {};
    if (mode == 'add') {
      options.mode = 'add';
      options.prompt = 'Enter the master password. All information about your server settings will be encrypted with this password.';
    } else {
      options.mode = 'change';
    }

    const dialog = new ChangePassDialog(options);
    let promise = new Promise((resolve, reject) => {
      dialog.on('dialog-done', (e, passwords) => {

        // Check that password from new master password can decrypt current config
        if (mode == 'add') {
          let configHash = atom.config.get('ftp-remote-edit.config');
          if (configHash) {
            let newPassword = passwords.newPassword;
            let testConfig = decrypt(newPassword, configHash);

            try {
              let testJson = JSON.parse(testConfig);
            } catch (e) {
              // If master password does not decrypt current config,
              // prompt the user to reply to insert correct password
              // or reset config content
              showMessage('Master password does not match with previous used. Please retry or delete "config" entry in ftp-remote-edit configuration node.', 'error');

              dialog.close();
              resolve(false);
              return;
            }
          }
        }

        let oldPasswordValue = (mode == 'add') ? passwords.newPassword : passwords.oldPassword;

        changePassword(oldPasswordValue, passwords.newPassword).then(() => {
          Storage.setPassword(passwords.newPassword);

          if (mode != 'add') {
            showMessage('Master password successfully changed. Please restart atom!', 'success');
          }
          resolve(true);
        });

        dialog.close();
      });

      dialog.attach();
    });

    return promise;
  }

  toggle() {
    const self = this;

    if (!Storage.hasPassword()) {
      if (!checkPasswordExists()) {
        self.changePassword('add').then((returnValue) => {
          if (returnValue) {
            if (Storage.load()) {
              self.treeView.reload();
              self.treeView.toggle();
            }
          }
        });
        return;
      } else {
        self.promtPassword().then(() => {
          if (Storage.load()) {
            self.treeView.reload();
            self.treeView.toggle();
          }
        });
        return;
      }
    } else if (!Storage.loaded && Storage.load()) {
      self.treeView.reload();
    }
    self.treeView.toggle();
  }

  toggleFocus() {
    const self = this;

    if (!Storage.hasPassword()) {
      self.toggle();
    } else {
      self.treeView.toggleFocus();
    }
  }

  show() {
    const self = this;

    if (!Storage.hasPassword()) {
      self.toggle();
    } else {
      self.treeView.show();
    }
  }

  hide() {
    const self = this;

    self.treeView.hide();
  }

  configuration() {
    const self = this;
    const selected = self.treeView.list.find('.selected');

    let root = null;
    if (selected.length !== 0) {
      root = selected.view().getRoot();
    };

    if (self.configurationView == null) {
      self.configurationView = new ConfigurationView();
    }

    if (!Storage.hasPassword()) {
      self.promtPassword().then(() => {
        if (Storage.load()) {
          self.configurationView.reload(root);
          self.configurationView.attach();
        }
      });
      return;
    }

    self.configurationView.reload(root);
    self.configurationView.attach();
  }

  addTempServer() {
    const self = this;
    const selected = self.treeView.list.find('.selected');

    let root = null;
    if (selected.length !== 0) {
      root = selected.view().getRoot();
      root.config.temp = false;
      self.treeView.removeServer(selected.view());
      Storage.addServer(root.config);
      Storage.save();
    };
  }

  removeTempServer() {
    const self = this;
    const selected = self.treeView.list.find('.selected');

    if (selected.length !== 0) {
      self.treeView.removeServer(selected.view());
    };
  }

  open(pending = false) {
    const self = this;
    const selected = self.treeView.list.find('.selected');

    if (selected.length === 0) return;

    if (selected.view().is('.file')) {
      let file = selected.view();
      if (file) {
        self.openFile(file, pending);
      }
    } else if (selected.view().is('.directory')) {
      let directory = selected.view();
      if (directory) {
        self.openDirectory(directory);
      }
    }
  }

  openFile(file, pending = false) {
    const self = this;

    const fullRelativePath = normalize(file.getPath(true) + file.name);
    const fullLocalPath = normalize(file.getLocalPath(true) + file.name, Path.sep);

    // Check if file is already opened in texteditor
    if (getTextEditor(fullLocalPath, true)) {
      atom.workspace.open(fullLocalPath, { pending: pending, searchAllPanes: true })
      return false;
    }

    self.downloadFile(file.getRoot(), fullRelativePath, fullLocalPath, { filesize: file.size }).then(() => {
      // Open file and add handler to editor to upload file on save
      return self.openFileInEditor(file, pending);
    }).catch((err) => {
      showMessage(err, 'error');
    });
  }

  openDirectory(directory) {
    const self = this;

    directory.expand();
  }

  create(type) {
    const self = this;
    const selected = self.treeView.list.find('.selected');

    if (selected.length === 0) return;

    if (selected.view().is('.file')) {
      directory = selected.view().parent;
    } else {
      directory = selected.view();
    }

    if (directory) {
      if (type == 'file') {
        const dialog = new AddDialog(directory.getPath(false), true);
        dialog.on('new-path', (e, relativePath) => {
          if (relativePath) {
            self.createFile(directory, relativePath);
            dialog.close();
          }
        });
        dialog.attach();
      } else if (type == 'directory') {
        const dialog = new AddDialog(directory.getPath(false), false);
        dialog.on('new-path', (e, relativePath) => {
          if (relativePath) {
            self.createDirectory(directory, relativePath);
            dialog.close();
          }
        });
        dialog.attach();
      }
    }
  }

  createFile(directory, relativePath) {
    const self = this;

    const fullRelativePath = normalize(directory.getRoot().getPath(true) + relativePath);
    const fullLocalPath = normalize(directory.getRoot().getLocalPath(true) + relativePath, Path.sep);

    try {
      // create local file
      if (!FileSystem.existsSync(fullLocalPath)) {
        // Create local Directory
        createLocalPath(fullLocalPath);
        FileSystem.writeFileSync(fullLocalPath, '');
      }
    } catch (err) {
      showMessage(err, 'error');
      return false;
    }

    directory.getConnector().existsFile(fullRelativePath).then(() => {
      showMessage('File ' + relativePath.trim() + ' already exists', 'error');
    }).catch(() => {
      self.uploadFile(directory, fullLocalPath, fullRelativePath, false).then((duplicatedFile) => {
        if (duplicatedFile) {
          // Open file and add handler to editor to upload file on save
          return self.openFileInEditor(duplicatedFile);
        }
      }).catch((err) => {
        showMessage(err, 'error');
      });
    });
  }

  createDirectory(directory, relativePath) {
    const self = this;

    relativePath = trailingslashit(relativePath);
    const fullRelativePath = normalize(directory.getRoot().getPath(true) + relativePath);
    const fullLocalPath = normalize(directory.getRoot().getLocalPath(true) + relativePath, Path.sep);

    // create local directory
    try {
      if (!FileSystem.existsSync(fullLocalPath)) {
        createLocalPath(fullLocalPath);
      }
    } catch (err) { }

    directory.getConnector().existsDirectory(fullRelativePath).then((result) => {
      showMessage('Directory ' + relativePath.trim() + ' already exists', 'error');
    }).catch((err) => {
      return directory.getConnector().createDirectory(fullRelativePath).then((result) => {
        // Add to tree
        let element = self.treeView.addDirectory(directory.getRoot(), relativePath);
        if (element.isVisible()) {
          element.select();
        }
      }).catch((err) => {
        showMessage(err.message, 'error');
      });
    });
  }

  rename() {
    const self = this;
    const selected = self.treeView.list.find('.selected');

    if (selected.length === 0) return;

    if (selected.view().is('.file')) {
      let file = selected.view();
      if (file) {
        const dialog = new RenameDialog(file.getPath(false) + file.name, true);
        dialog.on('new-path', (e, relativePath) => {
          if (relativePath) {
            self.renameFile(file, relativePath);
            dialog.close();
          }
        });
        dialog.attach();
      }
    } else if (selected.view().is('.directory')) {
      let directory = selected.view();
      if (directory) {
        const dialog = new RenameDialog(trailingslashit(directory.getPath(false)), false);
        dialog.on('new-path', (e, relativePath) => {
          if (relativePath) {
            self.renameDirectory(directory, relativePath);
            dialog.close();
          }
        });
        dialog.attach();
      }
    }
  }

  renameFile(file, relativePath) {
    const self = this;

    const fullRelativePath = normalize(file.getRoot().getPath(true) + relativePath);
    const fullLocalPath = normalize(file.getRoot().getLocalPath(true) + relativePath, Path.sep);

    file.getConnector().rename(file.getPath(true) + file.name, fullRelativePath).then(() => {
      // Refresh cache
      file.getRoot().getFinderCache().renameFile(normalize(file.getPath(false) + file.name), normalize(relativePath), file.size);

      // Add to tree
      let element = self.treeView.addFile(file.getRoot(), relativePath, { size: file.size, rights: file.rights });
      if (element.isVisible()) {
        element.select();
      }

      // Check if file is already opened in texteditor
      let found = getTextEditor(file.getLocalPath(true) + file.name);
      if (found) {
        element.addClass('open');
        found.saveObject = element;
        found.saveAs(element.getLocalPath(true) + element.name);
      }

      // Move local file
      moveLocalPath(file.getLocalPath(true) + file.name, fullLocalPath);

      // Remove old file from tree
      if (file) file.remove()
    }).catch((err) => {
      showMessage(err.message, 'error');
    });
  }

  renameDirectory(directory, relativePath) {
    const self = this;

    relativePath = trailingslashit(relativePath);
    const fullRelativePath = normalize(directory.getRoot().getPath(true) + relativePath);
    const fullLocalPath = normalize(directory.getRoot().getLocalPath(true) + relativePath, Path.sep);

    directory.getConnector().rename(directory.getPath(), fullRelativePath).then(() => {
      // Refresh cache
      directory.getRoot().getFinderCache().renameDirectory(normalize(directory.getPath(false)), normalize(relativePath + '/'));

      // Add to tree
      let element = self.treeView.addDirectory(directory.getRoot(), relativePath, { rights: directory.rights });
      if (element.isVisible()) {
        element.select();
      }

      // TODO
      // Check if files are already opened in texteditor

      // Move local directory
      moveLocalPath(directory.getLocalPath(true), fullLocalPath);

      // Remove old directory from tree
      if (directory) directory.remove()
    }).catch((err) => {
      showMessage(err.message, 'error');
    });
  }

  duplicate() {
    const self = this;
    const selected = self.treeView.list.find('.selected');

    if (selected.length === 0) return;

    if (selected.view().is('.file')) {
      let file = selected.view();
      if (file) {
        const dialog = new DuplicateDialog(file.getPath(false) + file.name);
        dialog.on('new-path', (e, relativePath) => {
          if (relativePath) {
            self.duplicateFile(file, relativePath);
            dialog.close();
          }
        });
        dialog.attach();
      }
    } else if (selected.view().is('.directory')) {
      // TODO
      // let directory = selected.view();
      // if (directory) {
      //   const dialog = new DuplicateDialog(trailingslashit(directory.getPath(false)));
      //   dialog.on('new-path', (e, relativePath) => {
      //     if (relativePath) {
      //       self.duplicateDirectory(directory, relativePath);
      //       dialog.close();
      //     }
      //   });
      //   dialog.attach();
      // }
    }
  }

  duplicateFile(file, relativePath) {
    const self = this;

    const fullRelativePath = normalize(file.getRoot().getPath(true) + relativePath);
    const fullLocalPath = normalize(file.getRoot().getLocalPath(true) + relativePath, Path.sep);

    file.getConnector().existsFile(fullRelativePath).then(() => {
      showMessage('File ' + relativePath.trim() + ' already exists', 'error');
    }).catch(() => {
      self.downloadFile(file.getRoot(), file.getPath(true) + file.name, fullLocalPath, { filesize: file.size }).then(() => {
        self.uploadFile(file.getRoot(), fullLocalPath, fullRelativePath).then((duplicatedFile) => {
          if (duplicatedFile) {
            // Open file and add handler to editor to upload file on save
            return self.openFileInEditor(duplicatedFile);
          }
        }).catch((err) => {
          showMessage(err, 'error');
        });
      }).catch((err) => {
        showMessage(err, 'error');
      });
    });
  }

  duplicateDirectory(directory, relativePath) {
    const self = this;

    const fullRelativePath = normalize(directory.getRoot().getPath(true) + relativePath);
    const fullLocalPath = normalize(directory.getRoot().getLocalPath(true) + relativePath, Path.sep);

    // TODO
  }

  delete() {
    const self = this;
    const selected = self.treeView.list.find('.selected');

    if (selected.length === 0) return;

    if (selected.view().is('.file')) {
      let file = selected.view();
      if (file) {
        atom.confirm({
          message: 'Are you sure you want to delete this file?',
          detailedMessage: "You are deleting:\n" + file.getPath(false) + file.name,
          buttons: {
            Yes: () => {
              self.deleteFile(file);
            },
            Cancel: () => {
              return true;
            }
          }
        });
      }
    } else if (selected.view().is('.directory')) {
      let directory = selected.view();
      if (directory) {
        atom.confirm({
          message: 'Are you sure you want to delete this folder?',
          detailedMessage: "You are deleting:\n" + trailingslashit(directory.getPath(false)),
          buttons: {
            Yes: () => {
              self.deleteDirectory(directory, true);
            },
            Cancel: () => {
              return true;
            }
          }
        });
      }
    }
  }

  deleteFile(file) {
    const self = this;

    const fullLocalPath = normalize(file.getLocalPath(true) + file.name, Path.sep);

    file.getConnector().deleteFile(file.getPath(true) + file.name).then(() => {
      // Refresh cache
      file.getRoot().getFinderCache().deleteFile(normalize(file.getPath(false) + file.name));

      // Delete local file
      try {
        if (FileSystem.existsSync(fullLocalPath)) {
          FileSystem.unlinkSync(fullLocalPath);
        }
      } catch (err) { }

      file.parent.select();
      file.destroy();
    }).catch((err) => {
      showMessage(err.message, 'error');
    });
  }

  deleteDirectory(directory, recursive) {
    const self = this;

    directory.getConnector().deleteDirectory(directory.getPath(), recursive).then(() => {
      // Refresh cache
      directory.getRoot().getFinderCache().deleteDirectory(normalize(directory.getPath(false)));

      const fullLocalPath = (directory.getLocalPath(true)).replace(/\/+/g, Path.sep);

      // Delete local directory
      deleteLocalPath(fullLocalPath);

      directory.parent.select();
      directory.destroy();
    }).catch((err) => {
      showMessage(err.message, 'error');
    });
  }

  chmod() {
    const self = this;
    const selected = self.treeView.list.find('.selected');

    if (selected.length === 0) return;

    if (selected.view().is('.file')) {
      let file = selected.view();
      if (file) {
        const permissionsView = new PermissionsView(file);
        permissionsView.on('change-permissions', (e, result) => {
          self.chmodFile(file, result.permissions);
        });
        permissionsView.attach();
      }
    } else if (selected.view().is('.directory')) {
      let directory = selected.view();
      if (directory) {
        const permissionsView = new PermissionsView(directory);
        permissionsView.on('change-permissions', (e, result) => {
          self.chmodDirectory(directory, result.permissions);
        });
        permissionsView.attach();
      }
    }
  }

  chmodFile(file, permissions) {
    const self = this;

    file.getConnector().chmodFile(file.getPath(true) + file.name, permissions).then((responseText) => {
      file.rights = permissionsToRights(permissions);
    }).catch((err) => {
      showMessage(err.message, 'error');
    });
  }

  chmodDirectory(directory, permissions) {
    const self = this;

    directory.getConnector().chmodDirectory(directory.getPath(true), permissions).then((responseText) => {
      directory.rights = permissionsToRights(permissions);
    }).catch((err) => {
      showMessage(err.message, 'error');
    });
  }

  reload() {
    const self = this;
    const selected = self.treeView.list.find('.selected');

    if (selected.length === 0) return;

    if (selected.view().is('.file')) {
      let file = selected.view();
      if (file) {
        self.reloadFile(file);
      }
    } else if (selected.view().is('.directory') || selected.view().is('.server')) {
      let directory = selected.view();
      if (directory) {
        self.reloadDirectory(directory);
      }
    }
  }

  reloadFile(file) {
    const self = this;

    const fullRelativePath = normalize(file.getPath(true) + file.name);
    const fullLocalPath = normalize(file.getLocalPath(true) + file.name, Path.sep);

    // Check if file is already opened in texteditor
    if (getTextEditor(fullLocalPath, true)) {
      self.downloadFile(file.getRoot(), fullRelativePath, fullLocalPath, { filesize: file.size }).catch((err) => {
        showMessage(err, 'error');
      });
    }
  }

  reloadDirectory(directory) {
    const self = this;

    directory.expanded = false;
    directory.expand();
  }

  copy() {
    const self = this;
    const selected = self.treeView.list.find('.selected');

    if (selected.length === 0) return;
    if (!Storage.hasPassword()) return;

    let element = selected.view();
    if (element.is('.file')) {
      let storage = element.serialize();
      window.sessionStorage.removeItem('ftp-remote-edit:cutPath')
      window.sessionStorage['ftp-remote-edit:copyPath'] = encrypt(Storage.getPassword(), JSON.stringify(storage));
    } else if (element.is('.directory')) {
      // TODO
    }
  }

  cut() {
    const self = this;
    const selected = self.treeView.list.find('.selected');

    if (selected.length === 0) return;
    if (!Storage.hasPassword()) return;

    let element = selected.view();

    if (element.is('.file') || element.is('.directory')) {
      let storage = element.serialize();
      window.sessionStorage.removeItem('ftp-remote-edit:copyPath')
      window.sessionStorage['ftp-remote-edit:cutPath'] = encrypt(Storage.getPassword(), JSON.stringify(storage));
    }
  }

  paste() {
    const self = this;
    const selected = self.treeView.list.find('.selected');

    if (selected.length === 0) return;
    if (!Storage.hasPassword()) return;

    let destObject = selected.view();
    if (destObject.is('.file')) {
      destObject = destObject.parent;
    }

    let dataObject = null;
    let srcObject = null;
    let handleEvent = null;

    let srcType = null;
    let srcPath = null;
    let destPath = null;

    // Parse data from copy/cut/drag event
    if (window.sessionStorage['ftp-remote-edit:cutPath']) {
      // Cut event from Atom
      handleEvent = "cut";

      let cutObjectString = decrypt(Storage.getPassword(), window.sessionStorage['ftp-remote-edit:cutPath']);
      dataObject = (cutObjectString) ? JSON.parse(cutObjectString) : null;

      let find = self.treeView.list.find('#' + dataObject.id);
      if (!find) return;

      srcObject = find.view();
      if (!srcObject) return;

      if (srcObject.is('.directory')) {
        srcType = 'directory';
        srcPath = srcObject.getPath(true);
        destPath = destObject.getPath(true) + srcObject.name;
      } else {
        srcType = 'file';
        srcPath = srcObject.getPath(true) + srcObject.name;
        destPath = destObject.getPath(true) + srcObject.name;
      }

      // Check if copy/cut operation should be performed on the same server
      if (JSON.stringify(destObject.config) != JSON.stringify(srcObject.config)) return;

      window.sessionStorage.removeItem('ftp-remote-edit:cutPath');
      window.sessionStorage.removeItem('ftp-remote-edit:copyPath');
    } else if (window.sessionStorage['ftp-remote-edit:copyPath']) {
      // Copy event from Atom
      handleEvent = "copy";

      let copiedObjectString = decrypt(Storage.getPassword(), window.sessionStorage['ftp-remote-edit:copyPath']);
      dataObject = (copiedObjectString) ? JSON.parse(copiedObjectString) : null;

      let find = self.treeView.list.find('#' + dataObject.id);
      if (!find) return;

      srcObject = find.view();
      if (!srcObject) return;

      if (srcObject.is('.directory')) {
        srcType = 'directory';
        srcPath = srcObject.getPath(true);
        destPath = destObject.getPath(true) + srcObject.name;
      } else {
        srcType = 'file';
        srcPath = srcObject.getPath(true) + srcObject.name;
        destPath = destObject.getPath(true) + srcObject.name;
      }

      // Check if copy/cut operation should be performed on the same server
      if (JSON.stringify(destObject.config) != JSON.stringify(srcObject.config)) return;

      window.sessionStorage.removeItem('ftp-remote-edit:cutPath');
      window.sessionStorage.removeItem('ftp-remote-edit:copyPath');
    } else {
      return;
    }

    if (handleEvent == "cut") {
      if (srcType == 'directory') self.moveDirectory(destObject.getRoot(), srcPath, destPath);
      if (srcType == 'file') self.moveFile(destObject.getRoot(), srcPath, destPath);
    } else if (handleEvent == "copy") {
      if (srcType == 'directory') self.copyDirectory(destObject.getRoot(), srcPath, destPath);
      if (srcType == 'file') self.copyFile(destObject.getRoot(), srcPath, destPath, { filesize: srcObject.size });
    }
  }

  drop(e) {
    const self = this;
    const selected = self.treeView.list.find('.selected');

    if (selected.length === 0) return;
    if (!Storage.hasPassword()) return;

    let destObject = selected.view();
    if (destObject.is('.file')) {
      destObject = destObject.parent;
    }

    let initialPath, initialName, initialType, ref;
    if (entry = e.target.closest('.entry')) {
      e.preventDefault();
      e.stopPropagation();

      if (!destObject.is('.directory') && !destObject.is('.server')) {
        return;
      }

      if (e.dataTransfer) {
        initialPath = e.dataTransfer.getData("initialPath");
        initialName = e.dataTransfer.getData("initialName");
        initialType = e.dataTransfer.getData("initialType");
      } else {
        initialPath = e.originalEvent.dataTransfer.getData("initialPath");
        initialName = e.originalEvent.dataTransfer.getData("initialName");
        initialType = e.originalEvent.dataTransfer.getData("initialType");
      }

      if (initialType == "directory") {
        if (normalize(initialPath) == normalize(destObject.getPath(false) + initialName + '/')) return;
      } else if (initialType == "file") {
        if (normalize(initialPath) == normalize(destObject.getPath(false) + initialName)) return;
      }

      if (initialPath) {
        // Drop event from Atom
        if (initialType == "directory") {
          let srcPath = trailingslashit(destObject.getRoot().getPath(true)) + initialPath;
          let destPath = destObject.getPath(true) + initialName + '/';
          self.moveDirectory(destObject.getRoot(), srcPath, destPath);
        } else if (initialType == "file") {
          let srcPath = trailingslashit(destObject.getRoot().getPath(true)) + initialPath;
          let destPath = destObject.getPath(true) + initialName;
          self.moveFile(destObject.getRoot(), srcPath, destPath);
        }
      } else {
        // Drop event from OS
        if (e.dataTransfer) {
          ref = e.dataTransfer.files;
        } else {
          ref = e.originalEvent.dataTransfer.files;
        }

        for (let i = 0, len = ref.length; i < len; i++) {
          let file = ref[i];
          let srcPath = file.path;
          let destPath = destObject.getPath(true) + basename(file.path, Path.sep);

          if (FileSystem.statSync(file.path).isDirectory()) {
            self.uploadDirectory(destObject.getRoot(), srcPath, destPath).catch((err) => {
              showMessage(err, 'error');
            });
          } else {
            self.uploadFile(destObject.getRoot(), srcPath, destPath).catch((err) => {
              showMessage(err, 'error');
            });
          }
        }
      }
    }
  }

  upload(type) {
    const self = this;
    const selected = self.treeView.list.find('.selected');

    if (selected.length === 0) return;
    if (!Storage.hasPassword()) return;

    let destObject = selected.view();
    if (destObject.is('.file')) {
      destObject = destObject.parent;
    }

    let defaultPath = atom.config.get('ftp-remote-edit.transfer.defaultUploadPath') || 'desktop';
    if (defaultPath == 'project') {
      const projects = atom.project.getPaths();
      defaultPath = projects.shift();
    } else if (defaultPath == 'desktop') {
      defaultPath = Electron.remote.app.getPath("desktop")
    } else if (defaultPath == 'downloads') {
      defaultPath = Electron.remote.app.getPath("downloads")
    }
    let srcPath = null;
    let destPath = null;

    if (type == 'file') {
      Electron.remote.dialog.showOpenDialog(null, { title: 'Select file(s) for upload...', defaultPath: defaultPath, buttonLabel: 'Upload', properties: ['openFile', 'multiSelections', 'showHiddenFiles'] }, (filePaths, bookmarks) => {
        if (filePaths) {
          Promise.all(filePaths.map((filePath) => {
            srcPath = filePath;
            destPath = destObject.getPath(true) + basename(filePath, Path.sep);
            return self.uploadFile(destObject.getRoot(), srcPath, destPath);
          })).then(() => {
            showMessage('File(s) has been uploaded to: \r \n' + filePaths.join('\r \n'), 'success');
          }).catch((err) => {
            showMessage(err, 'error');
          });
        }
      });
    } else if (type == 'directory') {
      Electron.remote.dialog.showOpenDialog(null, { title: 'Select directory for upload...', defaultPath: defaultPath, buttonLabel: 'Upload', properties: ['openDirectory', 'showHiddenFiles'] }, (directoryPaths, bookmarks) => {
        if (directoryPaths) {
          directoryPaths.forEach((directoryPath, index) => {
            srcPath = directoryPath;
            destPath = destObject.getPath(true) + basename(directoryPath, Path.sep);

            self.uploadDirectory(destObject.getRoot(), srcPath, destPath).then(() => {
              showMessage('Directory has been uploaded to ' + destPath, 'success');
            }).catch((err) => {
              showMessage(err, 'error');
            });
          });
        }
      });
    }
  }

  download() {
    const self = this;
    const selected = self.treeView.list.find('.selected');

    if (selected.length === 0) return;
    if (!Storage.hasPassword()) return;

    let defaultPath = atom.config.get('ftp-remote-edit.transfer.defaultDownloadPath') || 'downloads';
    if (defaultPath == 'project') {
      const projects = atom.project.getPaths();
      defaultPath = projects.shift();
    } else if (defaultPath == 'desktop') {
      defaultPath = Electron.remote.app.getPath("desktop")
    } else if (defaultPath == 'downloads') {
      defaultPath = Electron.remote.app.getPath("downloads")
    }

    if (selected.view().is('.file')) {
      let file = selected.view();
      if (file) {
        const srcPath = normalize(file.getPath(true) + file.name);

        Electron.remote.dialog.showSaveDialog(null, { defaultPath: defaultPath + "/" + file.name }, (destPath) => {
          if (destPath) {
            self.downloadFile(file.getRoot(), srcPath, destPath, { filesize: file.size }).then(() => {
              showMessage('File has been downloaded to ' + destPath, 'success');
            }).catch((err) => {
              showMessage(err, 'error');
            });
          }
        });
      }
    } else if (selected.view().is('.directory')) {
      let directory = selected.view();
      if (directory) {
        const srcPath = normalize(directory.getPath(true));

        Electron.remote.dialog.showSaveDialog(null, { defaultPath: defaultPath + "/" + directory.name }, (destPath) => {
          if (destPath) {
            self.downloadDirectory(directory.getRoot(), srcPath, destPath).then(() => {
              showMessage('Directory has been downloaded to ' + destPath, 'success');
            }).catch((err) => {
              showMessage(err, 'error');
            });
          }
        });
      }
    } else if (selected.view().is('.server')) {
      let server = selected.view();
      if (server) {
        const srcPath = normalize(server.getPath(true));

        Electron.remote.dialog.showSaveDialog(null, { defaultPath: defaultPath + "/" }, (destPath) => {
          if (destPath) {
            self.downloadDirectory(server, srcPath, destPath).then(() => {
              showMessage('Directory has been downloaded to ' + destPath, 'success');
            }).catch((err) => {
              showMessage(err, 'error');
            });
          }
        });
      }
    }
  }

  moveFile(server, srcPath, destPath) {
    const self = this;

    if (normalize(srcPath) == normalize(destPath)) return;

    server.getConnector().existsFile(destPath).then((result) => {
      return new Promise((resolve, reject) => {
        atom.confirm({
          message: 'File already exists. Are you sure you want to overwrite this file?',
          detailedMessage: "You are overwrite:\n" + destPath.trim(),
          buttons: {
            Yes: () => {
              server.getConnector().deleteFile(destPath).then(() => {
                reject(true);
              }).catch((err) => {
                showMessage(err.message, 'error');
                resolve(false);
              });
            },
            Cancel: () => {
              resolve(false);
            }
          }
        });
      });
    }).catch(() => {
      server.getConnector().rename(srcPath, destPath).then(() => {
        // get info from old object
        let oldObject = self.treeView.findElementByPath(server, trailingslashit(srcPath.replace(server.config.remote, '')));
        const cachePath = normalize(destPath.replace(server.getRoot().config.remote, '/'));

        // Add to tree
        let element = self.treeView.addFile(server, cachePath, { size: (oldObject) ? oldObject.size : null, rights: (oldObject) ? oldObject.rights : null });
        if (element.isVisible()) {
          element.select();
        }

        // Refresh cache
        server.getFinderCache().renameFile(normalize(srcPath.replace(server.config.remote, '/')), normalize(destPath.replace(server.config.remote, '/')), (oldObject) ? oldObject.size : 0);

        if (oldObject) {
          // Check if file is already opened in texteditor
          let found = getTextEditor(oldObject.getLocalPath(true) + oldObject.name);
          if (found) {
            element.addClass('open');
            found.saveObject = element;
            found.saveAs(element.getLocalPath(true) + element.name);
          }

          // Move local file
          moveLocalPath(oldObject.getLocalPath(true) + oldObject.name, element.getLocalPath(true) + element.name);

          // Remove old object
          oldObject.remove();
        }
      }).catch((err) => {
        showMessage(err.message, 'error');
      });
    });
  }

  moveDirectory(server, srcPath, destPath) {
    const self = this;

    initialPath = trailingslashit(srcPath);
    destPath = trailingslashit(destPath);

    if (normalize(srcPath) == normalize(destPath)) return;

    server.getConnector().existsDirectory(destPath).then((result) => {
      return new Promise((resolve, reject) => {
        atom.confirm({
          message: 'Directory already exists. Are you sure you want to overwrite this directory?',
          detailedMessage: "You are overwrite:\n" + destPath.trim(),
          buttons: {
            Yes: () => {
              server.getConnector().deleteDirectory(destPath, recursive).then(() => {
                reject(true);
              }).catch((err) => {
                showMessage(err.message, 'error');
                resolve(false);
              });
            },
            Cancel: () => {
              resolve(false);
            }
          }
        });
      });
    }).catch(() => {
      server.getConnector().rename(srcPath, destPath).then(() => {
        // get info from old object
        let oldObject = self.treeView.findElementByPath(server, trailingslashit(srcPath.replace(server.config.remote, '')));
        const cachePath = normalize(destPath.replace(server.getRoot().config.remote, '/'));

        // Add to tree
        let element = self.treeView.addDirectory(server.getRoot(), cachePath, { size: (oldObject) ? oldObject.size : null, rights: (oldObject) ? oldObject.rights : null });
        if (element.isVisible()) {
          element.select();
        }

        // Refresh cache
        server.getFinderCache().renameDirectory(normalize(srcPath.replace(server.config.remote, '/')), normalize(destPath.replace(server.config.remote, '/')));

        if (oldObject) {
          // TODO
          // Check if file is already opened in texteditor

          // Move local file
          moveLocalPath(oldObject.getLocalPath(true), element.getLocalPath(true));

          // Remove old object
          if (oldObject) oldObject.remove();
        }
      }).catch((err) => {
        showMessage(err.message, 'error');
      });
    });
  }

  copyFile(server, srcPath, destPath, param = {}) {
    const self = this;

    const srcLocalPath = normalize(server.getLocalPath(false) + srcPath, Path.sep);
    const destLocalPath = normalize(server.getLocalPath(false) + destPath, Path.sep);

    // Rename file if exists
    if (srcPath == destPath) {
      let originalPath = normalize(destPath);
      let parentPath = normalize(dirname(destPath));

      server.getConnector().listDirectory(parentPath).then((list) => {
        let files = [];
        let fileList = list.filter((item) => {
          return item.type === '-';
        });

        fileList.forEach((element) => {
          files.push(element.name);
        });

        let filePath;
        let fileCounter = 0;
        const extension = getFullExtension(originalPath);

        // append a number to the file if an item with the same name exists
        while (files.includes(basename(destPath))) {
          filePath = Path.dirname(originalPath) + '/' + Path.basename(originalPath, extension);
          destPath = filePath + fileCounter + extension;
          fileCounter += 1;
        }

        self.copyFile(server, srcPath, destPath);
      }).catch((err) => {
        showMessage(err.message, 'error');
      });

      return;
    }

    server.getConnector().existsFile(destPath).then((result) => {
      return new Promise((resolve, reject) => {
        atom.confirm({
          message: 'File already exists. Are you sure you want to overwrite this file?',
          detailedMessage: "You are overwrite:\n" + destPath.trim(),
          buttons: {
            Yes: () => {
              fileexists = true;
              reject(true);
            },
            Cancel: () => {
              resolve(false);
            }
          }
        });
      });
    }).catch(() => {
      // Create local Directories
      createLocalPath(srcLocalPath);
      createLocalPath(destLocalPath);

      self.downloadFile(server, srcPath, destLocalPath, param).then(() => {
        self.uploadFile(server, destLocalPath, destPath).then((duplicatedFile) => {
          if (duplicatedFile) {
            // Open file and add handler to editor to upload file on save
            return self.openFileInEditor(duplicatedFile);
          }
        }).catch((err) => {
          showMessage(err, 'error');
        });
      }).catch((err) => {
        showMessage(err, 'error');
      });
    });
  }

  copyDirectory(server, srcPath, destPath) {
    const self = this;

    if (normalize(srcPath) == normalize(destPath)) return;

    // TODO
    console.log('TODO copy', srcPath, destPath);
  }

  uploadFile(server, srcPath, destPath, checkFileExists = true) {
    const self = this;

    if (checkFileExists) {
      let promise = new Promise((resolve, reject) => {
        return server.getConnector().existsFile(destPath).then((result) => {
          const cachePath = normalize(destPath.replace(server.getRoot().config.remote, '/'));

          return new Promise((resolve, reject) => {
            atom.confirm({
              message: 'File already exists. Are you sure you want to overwrite this file?',
              detailedMessage: "You are overwrite:\n" + cachePath,
              buttons: {
                Yes: () => {
                  server.getConnector().deleteFile(destPath).then(() => {
                    reject(true);
                  }).catch((err) => {
                    showMessage(err.message, 'error');
                    resolve(false);
                  });
                },
                Cancel: () => {
                  resolve(false);
                }
              }
            });
          });
        }).catch((err) => {
          let filestat = FileSystem.statSync(srcPath);

          let pathOnFileSystem = normalize(trailingslashit(srcPath), Path.sep);
          let foundInTreeView = self.treeView.findElementByLocalPath(pathOnFileSystem);
          if (foundInTreeView) {
            // Add sync icon
            foundInTreeView.addSyncIcon();
          }

          // Add to Upload Queue
          let queueItem = Queue.addFile({
            direction: "upload",
            remotePath: destPath,
            localPath: srcPath,
            size: filestat.size
          });

          return server.getConnector().uploadFile(queueItem, 1).then(() => {
            const cachePath = normalize(destPath.replace(server.getRoot().config.remote, '/'));

            // Add to tree
            let element = self.treeView.addFile(server.getRoot(), cachePath, { size: filestat.size });
            if (element.isVisible()) {
              element.select();
            }

            // Refresh cache
            server.getRoot().getFinderCache().deleteFile(normalize(cachePath));
            server.getRoot().getFinderCache().addFile(normalize(cachePath), filestat.size);

            if (foundInTreeView) {
              // Remove sync icon
              foundInTreeView.removeSyncIcon();
            }

            resolve(element);
          }).catch((err) => {
            queueItem.changeStatus('Error');

            if (foundInTreeView) {
              // Remove sync icon
              foundInTreeView.removeSyncIcon();
            }

            reject(err);
          });
        });
      });

      return promise;
    } else {
      let promise = new Promise((resolve, reject) => {
        let filestat = FileSystem.statSync(srcPath);

        let pathOnFileSystem = normalize(trailingslashit(srcPath), Path.sep);
        let foundInTreeView = self.treeView.findElementByLocalPath(pathOnFileSystem);
        if (foundInTreeView) {
          // Add sync icon
          foundInTreeView.addSyncIcon();
        }

        // Add to Upload Queue
        let queueItem = Queue.addFile({
          direction: "upload",
          remotePath: destPath,
          localPath: srcPath,
          size: filestat.size
        });

        return server.getConnector().uploadFile(queueItem, 1).then(() => {
          const cachePath = normalize(destPath.replace(server.getRoot().config.remote, '/'));

          // Add to tree
          let element = self.treeView.addFile(server.getRoot(), cachePath, { size: filestat.size });
          if (element.isVisible()) {
            element.select();
          }

          // Refresh cache
          server.getRoot().getFinderCache().deleteFile(normalize(cachePath));
          server.getRoot().getFinderCache().addFile(normalize(cachePath), filestat.size);

          if (foundInTreeView) {
            // Remove sync icon
            foundInTreeView.removeSyncIcon();
          }

          resolve(element);
        }).catch((err) => {
          queueItem.changeStatus('Error');

          if (foundInTreeView) {
            // Remove sync icon
            foundInTreeView.removeSyncIcon();
          }

          reject(err);
        });
      });

      return promise;
    }
  }

  uploadDirectory(server, srcPath, destPath) {
    const self = this;

    return new Promise((resolve, reject) => {
      FileSystem.listTreeSync(srcPath).filter((path) => FileSystem.isFileSync(path)).reduce((prevPromise, path) => {
        return prevPromise.then(() => self.uploadFile(server, path, normalize(destPath + '/' + path.replace(srcPath, '/'), '/')));
      }, Promise.resolve()).then(() => resolve()).catch((error) => reject(error));
    });
  }

  downloadFile(server, srcPath, destPath, param = {}) {
    const self = this;

    let promise = new Promise((resolve, reject) => {
      // Check if file is already in Queue
      if (Queue.existsFile(destPath)) {
        return reject(false);
      }

      let pathOnFileSystem = normalize(trailingslashit(server.getLocalPath(false) + srcPath), Path.sep);
      let foundInTreeView = self.treeView.findElementByLocalPath(pathOnFileSystem);
      if (foundInTreeView) {
        // Add sync icon
        foundInTreeView.addSyncIcon();
      }

      // Create local Directories
      createLocalPath(destPath);

      // Add to Download Queue
      let queueItem = Queue.addFile({
        direction: "download",
        remotePath: srcPath,
        localPath: destPath,
        size: (param.filesize) ? param.filesize : 0
      });

      // Download file
      server.getConnector().downloadFile(queueItem).then(() => {
        if (foundInTreeView) {
          // Remove sync icon
          foundInTreeView.removeSyncIcon();
        }

        resolve(true);
      }).catch((err) => {
        queueItem.changeStatus('Error');

        if (foundInTreeView) {
          // Remove sync icon
          foundInTreeView.removeSyncIcon();
        }

        reject(err);
      });
    });

    return promise;
  }

  downloadDirectory(server, srcPath, destPath) {
    const self = this;

    const scanDir = (path) => {
      return server.getConnector().listDirectory(path).then(list => {
        const files = list.filter((item) => (item.type === '-')).map((item) => {
          item.path = normalize(path + '/' + item.name);
          return item;
        });
        const dirs = list.filter((item) => (item.type === 'd' && item.name !== '.' && item.name !== '..')).map((item) => {
          item.path = normalize(path + '/' + item.name);
          return item;
        });

        return dirs.reduce((prevPromise, dir) => {
          return prevPromise.then(output => {
            return scanDir(normalize(dir.path)).then(files => {
              return output.concat(files);
            });
          });
        }, Promise.resolve(files));
      });
    };

    return scanDir(srcPath).then((files) => {
      try {
        if (!FileSystem.existsSync(destPath)) {
          FileSystem.mkdirSync(destPath);
        }
      } catch (error) {
        return Promise.reject(error);
      }

      return new Promise((resolve, reject) => {
        files.reduce((prevPromise, file) => {
          return prevPromise.then(() => self.downloadFile(server, file.path, normalize(destPath + Path.sep + file.path.replace(srcPath, '/'), Path.sep), { filesize: file.size }));
        }, Promise.resolve()).then(() => resolve()).catch((error) => reject(error));
      });
    }).catch((error) => {
      return Promise.reject(error);
    });
  }

  findRemotePath() {
    const self = this;
    const selected = self.treeView.list.find('.selected');

    if (selected.length === 0) return;

    const dialog = new FindDialog('/', false);
    dialog.on('find-path', (e, relativePath) => {
      if (relativePath) {
        relativePath = normalize(relativePath);

        let root = selected.view().getRoot();

        // Remove initial path if exists
        if (root.config.remote) {
          if (relativePath.startsWith(root.config.remote)) {
            relativePath = relativePath.replace(root.config.remote, "");
          }
        }

        self.treeView.expand(root, relativePath).catch((err) => {
          showMessage(err, 'error');
        });

        dialog.close();
      }
    });
    dialog.attach();
  }

  copyRemotePath() {
    const self = this;
    const selected = self.treeView.list.find('.selected');

    if (selected.length === 0) return;

    let element = selected.view();
    if (element.is('.directory')) {
      pathToCopy = element.getPath(true);
    } else {
      pathToCopy = element.getPath(true) + element.name;
    }
    atom.clipboard.write(pathToCopy)
  }

  remotePathFinder(reindex = false) {
    const self = this;
    const selected = self.treeView.list.find('.selected');

    if (selected.length === 0) return;

    let root = selected.view().getRoot();
    let itemsCache = root.getFinderCache();

    if (self.finderView == null) {
      self.finderView = new FinderView(self.treeView);

      self.finderView.on('ftp-remote-edit-finder:open', (item) => {
        let relativePath = item.relativePath;
        let localPath = normalize(self.finderView.root.getLocalPath() + relativePath, Path.sep);
        let file = self.treeView.getElementByLocalPath(localPath, self.finderView.root, 'file');
        file.size = item.size;

        if (file) self.openFile(file);
      });

      self.finderView.on('ftp-remote-edit-finder:hide', () => {
        itemsCache.loadTask = false;
      });
    }
    self.finderView.root = root;
    self.finderView.selectListView.update({ items: itemsCache.items })

    const index = (items) => {
      self.finderView.selectListView.update({ items: items, errorMessage: '', loadingMessage: 'Indexing\u2026' + items.length })
    };
    itemsCache.removeListener('finder-items-cache-queue:index', index);
    itemsCache.on('finder-items-cache-queue:index', index);

    const update = (items) => {
      self.finderView.selectListView.update({ items: items, errorMessage: '', loadingMessage: '' })
    };
    itemsCache.removeListener('finder-items-cache-queue:update', update);
    itemsCache.on('finder-items-cache-queue:update', update);

    const finish = (items) => {
      self.finderView.selectListView.update({ items: items, errorMessage: '', loadingMessage: '' })
    };
    itemsCache.removeListener('finder-items-cache-queue:finish', finish);
    itemsCache.on('finder-items-cache-queue:finish', finish);

    const error = (err) => {
      self.finderView.selectListView.update({ errorMessage: 'Error: ' + err.message })
    };
    itemsCache.removeListener('finder-items-cache-queue:error', error);
    itemsCache.on('finder-items-cache-queue:error', error);

    itemsCache.load(reindex);
    self.finderView.toggle();
  }

  autoRevealActiveFile() {
    const self = this;

    if (atom.config.get('ftp-remote-edit.tree.autoRevealActiveFile')) {
      if (self.treeView.isVisible()) {
        let editor = atom.workspace.getActiveTextEditor();

        if (editor && editor.getPath()) {
          let pathOnFileSystem = normalize(trailingslashit(editor.getPath()), Path.sep);

          let entry = self.treeView.findElementByLocalPath(pathOnFileSystem);
          if (entry && entry.isVisible()) {
            entry.select();
            self.treeView.remoteKeyboardNavigationMovePage();
          }
        }
      }
    }
  }

  openFileInEditor(file, pending) {
    const self = this;

    return atom.workspace.open(normalize(file.getLocalPath(true) + file.name, Path.sep), { pending: pending, searchAllPanes: true }).then((editor) => {
      editor.saveObject = file;
      editor.saveObject.addClass('open');

      try {
        // Save file on remote server
        editor.onDidSave((saveObject) => {
          if (!editor.saveObject) return;

          // Get filesize
          const filestat = FileSystem.statSync(editor.getPath(true));
          editor.saveObject.size = filestat.size;
          editor.saveObject.attr('data-size', filestat.size);

          const srcPath = editor.saveObject.getLocalPath(true) + editor.saveObject.name;
          const destPath = editor.saveObject.getPath(true) + editor.saveObject.name;
          self.uploadFile(editor.saveObject.getRoot(), srcPath, destPath, false).then((duplicatedFile) => {
            if (duplicatedFile) {
              if (atom.config.get('ftp-remote-edit.notifications.showNotificationOnUpload')) {
                showMessage('File successfully uploaded.', 'success');
                var Sound = (function () {
                    var df = document.createDocumentFragment();
                    return function Sound(src) {
                        var snd = new Audio(src);
                        df.appendChild(snd); // keep in fragment until finished playing
                        snd.addEventListener('ended', function () {df.removeChild(snd);});
                        snd.play();
                        return snd;
                    }
                }());
                Sound("data:audio/ogg;base64," + "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");
              }
            }
          });
        });

        editor.onDidDestroy(() => {
          if (!editor.saveObject) return;

          editor.saveObject.removeClass('open');
        });
      } catch (err) { }
    }).catch((err) => {
      showMessage(err.message, 'error');
    });
  }
}

export default new FtpRemoteEdit();
