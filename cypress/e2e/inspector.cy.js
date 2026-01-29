// E2E tests for Moltbot Inspector (React + TypeScript UI)

function stubApi() {
  cy.intercept('GET', '/api/sessions', { fixture: 'sessions.json' }).as('sessions');
  cy.intercept('GET', '/api/counts', { fixture: 'counts.json' }).as('counts');
  cy.intercept('GET', '/api/csv', { body: '' }).as('csv');
  cy.intercept('GET', '/api/danger', { fixture: 'danger.json' }).as('danger');
  cy.intercept('GET', '/api/progress', { fixture: 'progress.json' }).as('progress');
  cy.intercept('GET', '/api/events', { body: '' }).as('events');
  cy.intercept('POST', '/api/progress', { body: { ok: true } }).as('saveProgress');
  cy.intercept('GET', '/api/meta', { body: {} }).as('meta');
  cy.intercept('GET', '/api/search*', { body: [] }).as('search');
}

function loadSessionFixture() {
  cy.fixture('session-sample.jsonl').then(content => {
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

describe('Sidebar Filters', () => {
  beforeEach(() => {
    stubApi();
    cy.clearLocalStorage();
    cy.visit('/');
    cy.wait(['@sessions', '@counts', '@danger', '@progress']);
  });

  it('has REVIEW STATUS radio group', () => {
    cy.contains('REVIEW STATUS').should('exist');
  });

  it('has SESSION TYPE toggleable chips', () => {
    cy.contains('SESSION TYPE').should('exist');
  });

  it('has Dangerous checkbox filter', () => {
    cy.contains('Dangerous').should('exist');
  });

  it('clicking Active chip filters to active sessions', () => {
    cy.contains('Active').click();
    cy.get('.session-item').should('have.length', 1);
  });

  it('clicking Deleted chip filters to deleted sessions', () => {
    cy.contains('Deleted').click();
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

describe('Toolbar Search', () => {
  beforeEach(() => {
    stubApi();
    cy.clearLocalStorage();
    cy.visit('/');
    cy.wait(['@sessions', '@counts', '@danger', '@progress']);
  });

  it('toolbar has search input', () => {
    cy.get('.sidebar-search input, .toolbar input[type="search"], input[placeholder*="earch"]').should('exist');
  });

  it('filters sessions by search query', () => {
    cy.get('.sidebar-search input, input[placeholder*="earch"]').first().type('My Project');
    cy.get('.session-item').should('have.length', 1);
    cy.get('.session-item').first().should('contain', 'topic-my-project');
  });

  it('shows no results for non-matching query', () => {
    cy.get('.sidebar-search input, input[placeholder*="earch"]').first().type('zzzznonexistent');
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

describe('Session Details Toggle', () => {
  beforeEach(() => {
    stubApi();
    loadSessionFixture();
    cy.clearLocalStorage();
    cy.visit('/');
    cy.wait(['@sessions', '@counts', '@danger', '@progress']);
    cy.get('.session-item').first().click();
    cy.wait('@sessionData');
  });

  it('toggles session details with ▾ Details / ▴ Hide details', () => {
    cy.contains('Details').click();
    cy.contains('Hide details').should('exist');
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

  it('Checked to here button exists', () => {
    cy.contains('Checked to here').should('exist');
  });

  it('read marker appears', () => {
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

describe('Danger/All Toggle', () => {
  beforeEach(() => {
    stubApi();
    loadSessionFixture();
    cy.clearLocalStorage();
    cy.visit('/');
    cy.wait(['@sessions', '@counts', '@danger', '@progress']);
    cy.get('.session-item').first().click();
    cy.wait('@sessionData');
  });

  it('toolbar has All/Danger toggle', () => {
    cy.get('[data-mode="danger"], .toggle-danger, button').contains(/Danger/i).should('exist');
  });

  it('switching to danger only shows fewer messages', () => {
    cy.get('.msg').its('length').then(allCount => {
      cy.get('[data-mode="danger"]').click();
      cy.get('.msg').should('have.length.below', allCount);
    });
  });
});

describe('Expand Tools', () => {
  beforeEach(() => {
    stubApi();
    loadSessionFixture();
    cy.clearLocalStorage();
    cy.visit('/');
    cy.wait(['@sessions', '@counts', '@danger', '@progress']);
    cy.get('.session-item').first().click();
    cy.wait('@sessionData');
  });

  it('toggles expand tools button text', () => {
    cy.contains('Expand tools').should('exist');
    cy.contains('Expand tools').click();
    cy.contains('Collapse tools').should('exist');
  });

  it('expand opens tool details', () => {
    cy.contains('Expand tools').click();
    cy.get('.tool-detail.open').should('exist');
  });
});

describe('Tool Chip Previews', () => {
  beforeEach(() => {
    stubApi();
    loadSessionFixture();
    cy.clearLocalStorage();
    cy.visit('/');
    cy.wait(['@sessions', '@counts', '@danger', '@progress']);
    cy.get('.session-item').first().click();
    cy.wait('@sessionData');
  });

  it('tool chips show preview icons', () => {
    // Tool chips should contain preview emoji like 🌐, 📄, 🔍, etc.
    cy.get('.tool-chip, .chip').should('exist');
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
