// E2E tests for Moltbot Inspector

function stubApi() {
  cy.intercept('GET', '/api/sessions', { fixture: 'sessions.json' }).as('sessions');
  cy.intercept('GET', '/api/counts', { fixture: 'counts.json' }).as('counts');
  cy.intercept('GET', '/api/csv', { body: '' }).as('csv');
  cy.intercept('GET', '/api/danger', { fixture: 'danger.json' }).as('danger');
  cy.intercept('GET', '/api/progress', { fixture: 'progress.json' }).as('progress');
  cy.intercept('GET', '/api/events', { body: '' }).as('events');
  cy.intercept('POST', '/api/progress', { body: { ok: true } }).as('saveProgress');
}

function loadSessionFixture() {
  cy.fixture('session-sample.jsonl').then(content => {
    // content is the raw text
    cy.intercept('GET', '/api/session/*', { body: content, headers: { 'content-type': 'text/plain' } }).as('sessionData');
  });
}

describe('Page Load', () => {
  beforeEach(() => {
    stubApi();
    cy.visit('/');
    cy.wait(['@sessions', '@counts', '@danger', '@progress']);
  });

  it('renders the app with sidebar visible', () => {
    cy.get('.sidebar').should('be.visible');
    cy.contains('Moltbot Inspector').should('exist');
  });

  it('shows empty state when no session selected', () => {
    // Clear localStorage to ensure no session is pre-selected
    cy.clearLocalStorage();
    cy.visit('/');
    cy.wait(['@sessions', '@counts', '@danger', '@progress']);
    cy.get('.empty').should('contain', 'select a session');
  });
});

describe('Session List', () => {
  beforeEach(() => {
    stubApi();
    cy.visit('/');
    cy.wait(['@sessions', '@counts', '@danger', '@progress']);
  });

  it('shows correct number of sessions', () => {
    cy.get('.session-item').should('have.length', 3);
  });

  it('displays badges', () => {
    cy.get('.badge').should('exist');
  });

  it('shows danger badge on dangerous session', () => {
    cy.get('.badge.danger, .badge.danger-warn').should('exist');
  });
});

describe('Filters', () => {
  beforeEach(() => {
    stubApi();
    cy.clearLocalStorage();
    cy.visit('/');
    cy.wait(['@sessions', '@counts', '@danger', '@progress']);
  });

  it('All filter shows all sessions', () => {
    cy.get('.filter-btn').contains('All').click();
    cy.get('.filter-btn').contains('All').should('have.class', 'active');
    cy.get('.session-item').should('have.length', 3);
  });

  it('Deleted filter shows only deleted', () => {
    cy.get('.filter-btn').contains('Deleted').click();
    cy.get('.session-item').should('have.length', 1);
  });

  it('Active filter shows active sessions', () => {
    cy.get('.filter-btn').contains('Active').click();
    cy.get('.session-item').should('have.length', 1);
  });

  it('Orphan filter shows orphan sessions', () => {
    cy.get('.filter-btn').contains('Orphan').click();
    cy.get('.session-item').should('have.length', 1);
  });

  it('Dangerous filter shows sessions with danger', () => {
    cy.get('.filter-btn').contains('Dangerous').click();
    cy.get('.session-item').should('have.length', 1);
  });
});

describe('Sort', () => {
  beforeEach(() => {
    stubApi();
    cy.clearLocalStorage();
    cy.visit('/');
    cy.wait(['@sessions', '@counts', '@danger', '@progress']);
  });

  it('changing sort reorders list', () => {
    cy.get('.sort-select').select('Created ↓');
    cy.get('.session-item').first().should('contain', 'topic-my-project');
  });
});

describe('Search', () => {
  beforeEach(() => {
    stubApi();
    cy.clearLocalStorage();
    cy.visit('/');
    cy.wait(['@sessions', '@counts', '@danger', '@progress']);
  });

  it('filters sessions by search query', () => {
    cy.get('.sidebar-search input').type('My Project');
    cy.get('.session-item').should('have.length', 1);
    cy.get('.session-item').first().should('contain', 'topic-my-project');
  });

  it('shows no results for non-matching query', () => {
    cy.get('.sidebar-search input').type('zzzznonexistent');
    cy.get('.session-item').should('have.length', 0);
  });
});

describe('Select Session', () => {
  beforeEach(() => {
    stubApi();
    loadSessionFixture();
    cy.clearLocalStorage();
    cy.visit('/');
    cy.wait(['@sessions', '@counts', '@danger', '@progress']);
  });

  it('clicking session loads messages', () => {
    cy.get('.session-item').first().click();
    cy.wait('@sessionData');
    cy.get('.msg').should('exist');
  });
});

describe('Message Display', () => {
  beforeEach(() => {
    stubApi();
    loadSessionFixture();
    cy.clearLocalStorage();
    cy.visit('/');
    cy.wait(['@sessions', '@counts', '@danger', '@progress']);
    cy.get('.session-item').first().click();
    cy.wait('@sessionData');
  });

  it('renders user and assistant bubbles', () => {
    cy.get('.msg.user').should('exist');
    cy.get('.msg.assistant').should('exist');
  });

  it('shows timestamps', () => {
    cy.get('.time').should('exist');
  });

  it('shows message content', () => {
    cy.contains('Hello, please help me with my project').should('exist');
  });
});

describe('Read Progress', () => {
  beforeEach(() => {
    stubApi();
    loadSessionFixture();
    cy.clearLocalStorage();
    cy.visit('/');
    cy.wait(['@sessions', '@counts', '@danger', '@progress']);
    cy.get('.session-item').first().click();
    cy.wait('@sessionData');
  });

  it('clicking message marks as read', () => {
    cy.get('.msg.user').last().click();
    cy.wait('@saveProgress');
  });

  it('read marker appears', () => {
    // The fixture has lastReadId=msg-3, so marker should appear after msg-3
    cy.get('.read-marker').should('exist');
  });
});

describe('Danger Highlighting', () => {
  beforeEach(() => {
    stubApi();
    loadSessionFixture();
    cy.clearLocalStorage();
    cy.visit('/');
    cy.wait(['@sessions', '@counts', '@danger', '@progress']);
    cy.get('.session-item').first().click();
    cy.wait('@sessionData');
  });

  it('dangerous messages have danger class', () => {
    cy.get('.bubble.has-danger, .bubble.has-warning').should('exist');
  });

  it('danger chips visible', () => {
    cy.get('.danger-chip').should('exist');
  });
});

describe('Danger Only Toggle', () => {
  beforeEach(() => {
    stubApi();
    loadSessionFixture();
    cy.clearLocalStorage();
    cy.visit('/');
    cy.wait(['@sessions', '@counts', '@danger', '@progress']);
    cy.get('.session-item').first().click();
    cy.wait('@sessionData');
  });

  it('switching to danger only shows fewer messages', () => {
    cy.get('.msg').its('length').then(allCount => {
      cy.get('[data-mode="danger"]').click();
      cy.get('.msg').should('have.length.below', allCount);
    });
  });

  it('danger only blocks marking (shows warning title)', () => {
    cy.get('[data-mode="danger"]').click();
    cy.get('.msg').first().should('have.attr', 'title').and('contain', 'Switch to All Messages');
  });
});

describe('Rename Session', () => {
  beforeEach(() => {
    stubApi();
    loadSessionFixture();
    cy.clearLocalStorage();
    cy.visit('/');
    cy.wait(['@sessions', '@counts', '@danger', '@progress']);
    cy.get('.session-item').first().click();
    cy.wait('@sessionData');
  });

  it('clicking name opens edit input, saving triggers progress save', () => {
    cy.get('.main-header h2').click();
    cy.get('.main-header h2 input').should('exist');
    cy.get('.main-header h2 input').clear().type('Renamed Session{enter}');
    cy.wait('@saveProgress');
  });
});

describe('Expand All', () => {
  beforeEach(() => {
    stubApi();
    loadSessionFixture();
    cy.clearLocalStorage();
    cy.visit('/');
    cy.wait(['@sessions', '@counts', '@danger', '@progress']);
    cy.get('.session-item').first().click();
    cy.wait('@sessionData');
  });

  it('toggles expand button text', () => {
    cy.get('.expand-btn').should('contain', 'Expand all');
    cy.get('.expand-btn').click();
    cy.get('.expand-btn').should('contain', 'Collapse all');
  });

  it('expand all opens tool details', () => {
    cy.get('.expand-btn').click();
    cy.get('.tool-detail.open').should('exist');
  });
});

describe('Message Search', () => {
  beforeEach(() => {
    stubApi();
    loadSessionFixture();
    cy.clearLocalStorage();
    cy.visit('/');
    cy.wait(['@sessions', '@counts', '@danger', '@progress']);
    cy.get('.session-item').first().click();
    cy.wait('@sessionData');
  });

  it('filters messages by text', () => {
    cy.get('.msg-search input').type('Hello');
    cy.get('.msg').should('have.length.at.least', 1);
    cy.contains('Hello, please help me with my project').should('exist');
  });
});

describe('Mobile Layout', () => {
  beforeEach(() => {
    stubApi();
    cy.clearLocalStorage();
  });

  it('hamburger menu works on mobile viewport', () => {
    cy.viewport(375, 667);
    cy.visit('/');
    cy.wait(['@sessions', '@counts', '@danger', '@progress']);
    cy.get('.mobile-toggle').should('be.visible');
    cy.get('.mobile-toggle').click();
    cy.get('.sidebar.mobile-open').should('exist');
  });
});
