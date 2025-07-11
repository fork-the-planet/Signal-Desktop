// Copyright 2016 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { batch } from 'react-redux';
import { debounce } from 'lodash';

import * as Errors from '../types/errors';
import { createLogger } from '../logging/log';
import { DataReader, DataWriter } from '../sql/Client';
import { clearTimeoutIfNecessary } from '../util/clearTimeoutIfNecessary';
import { sleep } from '../util/sleep';
import { SECOND } from '../util/durations';
import { MessageModel } from '../models/messages';
import { cleanupMessages } from '../util/cleanup';
import { drop } from '../util/drop';

const log = createLogger('expiringMessagesDeletion');

class ExpiringMessagesDeletionService {
  #timeout?: ReturnType<typeof setTimeout>;
  #debouncedCheckExpiringMessages = debounce(this.#checkExpiringMessages, 1000);

  update() {
    drop(this.#debouncedCheckExpiringMessages());
  }

  async #destroyExpiredMessages() {
    try {
      log.info('destroyExpiredMessages: Loading messages...');
      const messages = await DataReader.getExpiredMessages();
      log.info(
        `destroyExpiredMessages: found ${messages.length} messages to expire`
      );

      const messageIds: Array<string> = [];
      const inMemoryMessages: Array<MessageModel> = [];

      messages.forEach(dbMessage => {
        const message = window.MessageCache.register(
          new MessageModel(dbMessage)
        );
        messageIds.push(message.id);
        inMemoryMessages.push(message);
      });

      await DataWriter.removeMessages(messageIds, {
        cleanupMessages,
      });

      batch(() => {
        inMemoryMessages.forEach(message => {
          log.info('Message expired', {
            sentAt: message.get('sent_at'),
          });

          // We do this to update the UI, if this message is being displayed somewhere
          window.reduxActions.conversations.messageExpired(message.id);
        });
      });
    } catch (error) {
      log.error(
        'destroyExpiredMessages: Error deleting expired messages',
        Errors.toLogFormat(error)
      );
      log.info(
        'destroyExpiredMessages: Waiting 30 seconds before trying again'
      );
      await sleep(30 * SECOND);
    }

    log.info('destroyExpiredMessages: done, scheduling another check');
    void this.update();
  }

  async #checkExpiringMessages() {
    log.info('checkExpiringMessages: checking for expiring messages');

    const soonestExpiry = await DataReader.getSoonestMessageExpiry();
    if (!soonestExpiry) {
      log.info('checkExpiringMessages: found no messages to expire');
      return;
    }

    let wait = soonestExpiry - Date.now();

    // In the past
    if (wait < 0) {
      wait = 0;
    }

    // Too far in the future, since it's limited to a 32-bit value
    if (wait > 2147483647) {
      wait = 2147483647;
    }

    log.info(
      `checkExpiringMessages: next message expires ${new Date(
        soonestExpiry
      ).toISOString()}; waiting ${wait} ms before clearing`
    );

    clearTimeoutIfNecessary(this.#timeout);
    this.#timeout = setTimeout(this.#destroyExpiredMessages.bind(this), wait);
  }
}

export function initialize(): void {
  if (instance) {
    log.warn('Expiring Messages Deletion service is already initialized!');
    return;
  }
  instance = new ExpiringMessagesDeletionService();
}

export function update(): void {
  if (!instance) {
    throw new Error('Expiring Messages Deletion service not yet initialized!');
  }
  instance.update();
}

let instance: ExpiringMessagesDeletionService;
